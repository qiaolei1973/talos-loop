import * as fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, buildProjectContextForIssue } from "../config.js";
import {
  getRunningSessions,
  getRunningSessionsWithIssues,
  createSession,
  updateSessionStatus,
  updateIssueTmux,
  updateIssueStatus,
} from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { IssueSourcePlugin, PluginCapability } from "../types/plugin.js";
import type { PollResult, IssueEntry } from "./poller.js";
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

/** Check running sessions; for each that has exited, classify the outcome. */
export async function checkRunningSessions(): Promise<{ completed: number; failed: number }> {
  const running = getRunningSessionsWithIssues();
  let completed = 0;
  let failed = 0;

  for (const { project_id, project_type, source_id, target_repo, ...session } of running) {
    if (tmux.isAlive(session.tmux_session)) continue;

    // Sessions skipped or completed via the HTTP API are no longer 'running'
    // (skip → 'skipped'; submit-pr leaves status 'running' but records pr_url),
    // so the pr_url set by the submit-pr action is the single source of truth for
    // completion — tmux output is no longer parsed for a PR URL.

    const plugin = await resolvePlugin(project_type);
    const ctx = buildProjectContextForIssue(project_id, log);
    const sourceName = plugin.name;

    if (session.pr_url) {
      log.info(`✅ ${sourceName}:${source_id} done — ${session.pr_url}`);
      updateSessionStatus(session.id, "done", session.pr_url);
      updateIssueStatus(project_id, source_id, "done");
      await plugin.transition(ctx, source_id, { from: "processing", to: "done" }, target_repo);
      if (plugin.onComment) {
        await plugin.onComment(ctx, source_id, `✅ Agent completed. PR: ${session.pr_url}`, target_repo);
      }
      updateIssueTmux(project_id, source_id, null);
      completed++;
    } else {
      // Infrastructure failure: silently return the issue to Ready so the next
      // poll auto-retries. The error tail is recorded on the session and surfaced
      // in the dashboard only — no comment is posted.
      const lastOutput = tmux.captureOutput(session.tmux_session);
      const tail = lastOutput.trim().slice(-500) || "Session exited without creating a PR";
      log.warn(`⚠️ ${sourceName}:${source_id} infrastructure failure — returning to Ready (error in dashboard)`);
      updateSessionStatus(session.id, "failed", undefined, tail);
      updateIssueStatus(project_id, source_id, "queued");
      await plugin.transition(ctx, source_id, { from: "processing", to: "queued" }, target_repo);
      updateIssueTmux(project_id, source_id, null);
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

    const scriptFile = path.join(os.tmpdir(), `tl-run-${session}.sh`);
    fs.writeFileSync(scriptFile, [
      `#!/bin/bash`,
      `cd ${repo.path}`,
      `claude "$(cat ${promptFile})" --dangerously-skip-permissions`,
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

      updateIssueTmux(projectId, sourceId, session);
      updateIssueStatus(projectId, sourceId, "processing");
      createSession(issue.id, session);

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
