import * as fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, buildProjectContextForIssue } from "../config.js";
import {
  getRunningSessions,
  getRunningSessionsWithIssues,
  createSession,
  updateSessionStatus,
} from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { IssueSourcePlugin, PluginCapability } from "../types/plugin.js";
import type { PollResult, IssueEntry } from "./poller.js";
import { setBoardStatus } from "./boardSnapshot.js";
import * as tmux from "./tmux.js";
import { createLogger } from "./logger.js";

const log = createLogger("dispatcher");

export interface DispatchResult {
  dispatched: number;
  completed: number;
  failed: number;
  idle: boolean;
}

/** A plugin's declared capabilities, or an empty list if it declares none. */
function pluginCapabilities(plugin: IssueSourcePlugin): PluginCapability[] {
  return plugin.capabilities?.() ?? [];
}

function buildPrompt(
  sourceId: string,
  url: string,
  repoPath: string,
  projectId: string,
  serverBaseUrl: string,
  targetRepo: string,
  capabilities: PluginCapability[],
): string {
  // projectId is "owner/number" — its "/" is a path delimiter, so it must be
  // percent-encoded here or the route (/api/projects/:projectId/...) won't match.
  const encodedProject = encodeURIComponent(projectId);
  const actionsBase = `${serverBaseUrl}/api/projects/${encodedProject}/issues/${sourceId}/actions`;
  // The API block is rendered from the plugin's declared capabilities, so the
  // prompt is always in sync with what the plugin supports — no dispatcher edit
  // is needed to surface a new action.
  const actionLines = capabilities.map((cap) => {
    const params = cap.params.map((p) => p.name).join(", ");
    return `- ${cap.action}：${cap.description}${params ? ` | 参数：${params}` : ""}`;
  });
  return [
    `你是一个自动化编码代理。请实现以下 Issue: ${url}`,
    ``,
    `要求：`,
    `- 阅读并理解 issue 内容`,
    `- 使用 git worktree 隔离工作（自行决定 worktree 路径和分支名，请使用语义化的分支名）`,
    `- 在 worktree 中完成所有开发工作`,
    `- 完成后提交代码并推送分支，再调用 submit-pr 操作创建关联 Issue 的 Pull Request（传入你的分支名）`,
    `- 最后清理 worktree：cd ${repoPath} && git worktree remove <你的worktree路径>`,
    ``,
    `与 talos-loop 通信（POST ${actionsBase}/{action}，JSON body 含 targetRepo: "${targetRepo}"）：`,
    ...actionLines.map((line) => `    ${line}`),
  ].join("\n");
}

/**
 * Check running sessions; for each that has exited, classify it by the process's
 * OWN exit state — not by whether the agent produced a PR (issue #20):
 *
 *   exit 0 + pr_url   → done, advance board (processing → done)   [the ONLY board move]
 *   exit 0, no pr_url → done, board unchanged
 *   non-zero / absent → failed, board unchanged
 *
 * Board state is driven exclusively by explicit agent actions (submit-pr, skip);
 * a session exit — clean or crashed — never rolls the board. A developer sees the
 * issue stay "In progress" alongside a failed-session indicator and investigates.
 */
export async function checkRunningSessions(): Promise<{ completed: number; failed: number }> {
  const running = getRunningSessionsWithIssues();
  let completed = 0;
  let failed = 0;

  for (const { project_id, project_type, source_id, target_repo, ...session } of running) {
    if (tmux.isAlive(session.tmux_session)) continue;

    // Sessions skipped or completed via the HTTP API are no longer 'running'
    // (skip → 'skipped'; submit-pr leaves status 'running' but records pr_url).
    // The exit-code sentinel written by the launcher is the source of truth for
    // clean vs. crashed termination; a missing sentinel means the process was
    // killed before it could record one → treat as a failure (issue #20).
    const exitCode = tmux.readExitCode(session.tmux_session);
    const cleanExit = exitCode === 0;

    const plugin = await resolvePlugin(project_type);
    const ctx = buildProjectContextForIssue(project_id, log);
    const sourceName = plugin.name;

    if (cleanExit && session.pr_url) {
      // Success path: clean exit AND a PR was submitted → finalize as done and
      // advance the board. This is the ONLY session-exit outcome that moves the
      // board — it reflects the deliberate submit-pr action.
      log.info(`✅ ${sourceName}:${source_id} done — ${session.pr_url}`);
      updateSessionStatus(session.id, "done", session.pr_url);
      await plugin.transition(ctx, source_id, { from: "processing", to: "done" }, target_repo);
      if (plugin.onComment) {
        await plugin.onComment(ctx, source_id, `✅ Agent completed. PR: ${session.pr_url}`, target_repo);
      }
      // Optimistically mirror the board move (processing → "In review") so the
      // dashboard shows done before the next poll re-reads the board.
      setBoardStatus(project_id, source_id, "In review");
      completed++;
    } else if (cleanExit) {
      // Clean exit but no PR — e.g. a review session (issue #19) or an agent that
      // chose not to submit. The session ran successfully, so it is `done`; the
      // board is left untouched because only an explicit submit-pr/skip advances it.
      log.info(`✅ ${sourceName}:${source_id} done — exited cleanly with no PR (board left In progress)`);
      updateSessionStatus(session.id, "done", undefined);
      completed++;
    } else {
      // Non-zero exit OR missing sentinel → infrastructure failure. The board is
      // intentionally left "In progress" so a developer notices and investigates
      // (issue #20) — it is no longer auto-rolled back to Ready, and prior work
      // (commits, worktree state) is preserved. The error tail is surfaced in the
      // dashboard only; no comment is posted.
      const reason = exitCode === undefined
        ? "Session terminated unexpectedly (no exit-code sentinel)"
        : `Session exited with code ${exitCode}`;
      const lastOutput = tmux.captureOutput(session.tmux_session);
      const tail = lastOutput.trim().slice(-500) || reason;
      log.warn(`⚠️ ${sourceName}:${source_id} ${reason} — leaving board In progress (error in dashboard)`);
      updateSessionStatus(session.id, "failed", undefined, tail);
      failed++;
    }
  }

  return { completed, failed };
}

/** Dispatch new issues from poll results */
export async function dispatchNew(pollResults: PollResult[]): Promise<number> {
  const config = loadConfig();
  const runningCount = getRunningSessions().length;

  if (runningCount >= config.maxParallel) {
    log.info(`Max parallel (${config.maxParallel}) reached, ${runningCount} running`);
    return 0;
  }

  const candidates: IssueEntry[] = pollResults.flatMap((r) => r.discovered);

  // Sort by sourceId (for GitHub, lower number = older = higher priority)
  candidates.sort((a, b) => {
    const aNum = parseInt(a.sourceId, 10);
    const bNum = parseInt(b.sourceId, 10);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    return a.sourceId.localeCompare(b.sourceId);
  });

  let dispatched = 0;
  const slotsAvailable = config.maxParallel - runningCount;

  for (const candidate of candidates) {
    if (dispatched >= slotsAvailable) break; // count actual dispatches, not iterations
    const { issue, projectId, projectType, sourceId, targetRepo } = candidate;

    const plugin = await resolvePlugin(projectType);
    const ctx = buildProjectContextForIssue(projectId, log);
    const sourceName = plugin.name;

    const repo = ctx.repos.find((r) => r.name === targetRepo);
    if (!repo) {
      log.error(`Repo "${targetRepo}" not found for ${sourceName}:${sourceId}`);
      continue;
    }

    // Real-time freshness check — only dispatch issues still actionable.
    const current = await plugin.getStatus(ctx, sourceId, targetRepo);
    if (current.state !== "queued") {
      log.info(`Skipping ${sourceName}:${sourceId} — not actionable (state ${current.state ?? "null"})`);
      continue;
    }

    const session = tmux.sessionName(sourceName, targetRepo, sourceId);
    const capabilities = pluginCapabilities(plugin);
    const prompt = buildPrompt(sourceId, issue.url, repo.path, projectId, config.serverBaseUrl, targetRepo, capabilities);

    const promptFile = path.join(os.tmpdir(), `tl-prompt-${session}.txt`);
    fs.writeFileSync(promptFile, prompt, "utf-8");

    // Issue #20: capture the agent's exit code in a sentinel file so
    // checkRunningSessions can classify the session as done (exit 0) or failed
    // (non-zero) independently of whether a PR was created. The path is shared
    // with tmux.readExitCode() so the writer and reader can never disagree.
    const exitCodeFile = tmux.exitCodePath(session);
    const scriptFile = path.join(os.tmpdir(), `tl-run-${session}.sh`);
    fs.writeFileSync(scriptFile, [
      `#!/bin/bash`,
      `cd ${repo.path}`,
      `claude "$(cat ${promptFile})" --dangerously-skip-permissions`,
      `echo $? > "${exitCodeFile}"`,
      `rm -f "${scriptFile}" "${promptFile}"`,
    ].join("\n"), "utf-8");
    fs.chmodSync(scriptFile, 0o755);
    const command = scriptFile;

    log.info(`🚀 Dispatching ${sourceName}:${sourceId} → session ${session}`);

    try {
      await plugin.transition(ctx, sourceId, { from: "queued", to: "processing" }, targetRepo);
      if (plugin.onComment) {
        await plugin.onComment(ctx, sourceId, "🤖 Agent has started processing this issue...", targetRepo);
      }

      tmux.createSession(session, command);

      createSession(issue.id, session);
      // Optimistically flip the board snapshot to "In progress" so the dashboard
      // reflects processing between this dispatch and the next poll (issue #13).
      setBoardStatus(projectId, sourceId, "In progress");

      dispatched++;
    } catch (err: any) {
      log.error(`Failed to dispatch ${sourceName}:${sourceId}: ${err.message}`);
      // Roll the board status back to Ready so the next poll retries.
      await plugin.transition(ctx, sourceId, { from: "processing", to: "queued" }, targetRepo);
    }
  }

  return dispatched;
}

/** Main dispatch cycle: check running + dispatch new */
export async function dispatch(pollResults: PollResult[]): Promise<DispatchResult> {
  const { completed, failed } = await checkRunningSessions();
  const dispatched = await dispatchNew(pollResults);
  const runningCount = getRunningSessions().length;

  return {
    dispatched,
    completed,
    failed,
    idle: runningCount === 0 && dispatched === 0,
  };
}
