import { execSync } from "child_process";
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

function buildPrompt(
  sourceId: string,
  url: string,
  repoPath: string,
  projectId: string,
  serverBaseUrl: string,
  targetRepo: string,
): string {
  // projectId is "owner/number" — its "/" is a path delimiter, so it must be
  // percent-encoded here or the route (/api/projects/:projectId/...) won't match.
  const encodedProject = encodeURIComponent(projectId);
  const skipUrl = `${serverBaseUrl}/api/projects/${encodedProject}/issues/${sourceId}/skip`;
  const commentUrl = `${serverBaseUrl}/api/projects/${encodedProject}/issues/${sourceId}/comment`;
  return [
    `你是一个自动化编码代理。请实现以下 Issue: ${url}`,
    ``,
    `要求：`,
    `- 阅读并理解 issue 内容`,
    `- 使用 git worktree 隔离工作（自行决定 worktree 路径和分支名，请使用语义化的分支名）`,
    `- 在 worktree 中完成所有开发工作`,
    `- 完成后提交代码，推送分支，并创建 Pull Request 关联 Issue`,
    `- 最后清理 worktree：cd ${repoPath} && git worktree remove <你的worktree路径>`,
    ``,
    `与 talos-loop 通信（JSON body，targetRepo 固定为 "${targetRepo}"）：`,
    `- 若判定无法完成该任务（需求不足、仓库错误等），调用 skip 接口放弃（不要硬编码跳过）：`,
    `    curl -s -X POST ${skipUrl} -H 'Content-Type: application/json' -d '{"reason":"<跳过原因>","targetRepo":"${targetRepo}"}'`,
    `- 如需在 issue 留言：`,
    `    curl -s -X POST ${commentUrl} -H 'Content-Type: application/json' -d '{"message":"<内容>","targetRepo":"${targetRepo}"}'`,
    ``,
    `完成后在输出中单独一行输出 PR 的 URL。`,
  ].join("\n");
}

/** Use gh CLI to find a PR that references the issue (any state: open, merged, closed) */
function findPrUrl(remote: string, sourceId: string): string | null {
  try {
    const result = execSync(
      `gh pr list --repo ${remote} --state all --search "fixes #${sourceId}" --json url --jq '.[0].url'`,
      { timeout: 15_000, encoding: "utf-8", stdio: "pipe" },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Check running sessions; for each that has exited, classify the outcome. */
export async function checkRunningSessions(): Promise<{ completed: number; failed: number }> {
  const running = getRunningSessionsWithIssues();
  let completed = 0;
  let failed = 0;

  for (const { project_id, project_type, source_id, target_repo, ...session } of running) {
    // Capture pane output while the session is still alive (before the isAlive check).
    const lastOutput = tmux.captureOutput(session.tmux_session);
    if (tmux.isAlive(session.tmux_session)) continue;

    // Sessions skipped via the HTTP API are no longer 'running' (the handler moved
    // them to 'skipped' and returned the issue to Ready), so they do not appear
    // here — the skip path needs no further transition or comment.

    const plugin = await resolvePlugin(project_type);
    const ctx = buildProjectContextForIssue(project_id, log);
    const sourceName = plugin.name;
    const repo = ctx.repos.find((r) => r.name === target_repo);
    const remote = repo?.remote ?? target_repo;

    const prMatch = lastOutput.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
    const prUrl = prMatch ? prMatch[0] : findPrUrl(remote, source_id);

    if (prUrl) {
      log.info(`✅ ${sourceName}:${source_id} done — ${prUrl}`);
      updateSessionStatus(session.id, "done", prUrl);
      updateIssueStatus(project_id, source_id, "done");
      await plugin.transition(ctx, source_id, { from: "processing", to: "done" }, target_repo);
      if (plugin.onComment) {
        await plugin.onComment(ctx, source_id, `✅ Agent completed. PR: ${prUrl}`, target_repo);
      }
      updateIssueTmux(project_id, source_id, null);
      completed++;
    } else {
      // Infrastructure failure: silently return the issue to Ready so the next
      // poll auto-retries. The error tail is recorded on the session and surfaced
      // in the dashboard only — no comment is posted.
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
    const prompt = buildPrompt(sourceId, issue.url, repo.path, projectId, config.serverBaseUrl, targetRepo);

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
