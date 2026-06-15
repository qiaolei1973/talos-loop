import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, buildSourceContextForRepo } from "../config.js";
import {
  getDb,
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
): string {
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
    `完成后在输出中单独一行输出 PR 的 URL。`,
  ].join("\n");
}

/** Use gh CLI to find a PR that references the issue (any state: open, merged, closed) */
function findPrUrl(remote: string, sourceId: string): string | null {
  try {
    const result = execSync(
      `gh pr list --repo ${remote} --state all --search "fixes #${sourceId}" --json url --jq '.[0].url'`,
      { timeout: 15_000, encoding: "utf-8" },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Check running sessions, detect completions */
async function checkRunningSessions(): Promise<{ completed: number; failed: number }> {
  const running = getRunningSessionsWithIssues();
  let completed = 0;
  let failed = 0;

  for (const { source_type, source_id, target_repo, ...session } of running) {
    // Capture pane output while session is still alive (before isAlive check)
    const lastOutput = tmux.captureOutput(session.tmux_session);

    if (tmux.isAlive(session.tmux_session)) {
      continue;
    }

    // Get plugin for status callbacks, resolving the bound repo for the context
    const plugin = await resolvePlugin(source_type);
    const ctx = buildSourceContextForRepo(target_repo, log);
    const sourceName = plugin.name;

    // Resolve remote for PR search (fall back to the repo-name key)
    const remote = ctx.repo?.remote ?? target_repo;

    // Session has exited — determine result
    const prMatch = lastOutput.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
    const prUrl = prMatch ? prMatch[0] : findPrUrl(remote, source_id);

    if (prUrl) {
      log.info(`✅ ${sourceName}:${source_id} done — ${prUrl}`);
      updateSessionStatus(session.id, "done", prUrl);
      updateIssueStatus(source_type, source_id, "done");

      await plugin.transition(ctx, source_id, { from: "processing", to: "done" });
      if (plugin.onComment) {
        await plugin.onComment(ctx, source_id, `✅ Agent completed. PR: ${prUrl}`);
      }

      updateIssueTmux(source_type, source_id, null);
      completed++;
    } else {
      const tail = lastOutput.trim().slice(-500) || "Session exited without creating a PR";
      log.info(`❌ ${sourceName}:${source_id} failed`);
      updateSessionStatus(session.id, "failed", undefined, tail);
      updateIssueStatus(source_type, source_id, "failed");

      await plugin.transition(ctx, source_id, { from: "processing", to: "failed" });
      if (plugin.onComment) {
        await plugin.onComment(ctx, source_id, `❌ Agent processing failed.\n\n\`\`\`\n${tail.slice(0, 1000)}\n\`\`\``);
      }

      updateIssueTmux(source_type, source_id, null);
      failed++;
    }
  }

  return { completed, failed };
}

/** Dispatch new issues from poll results */
async function dispatchNew(pollResults: PollResult[]): Promise<number> {
  const config = loadConfig();
  const { getRunningSessions } = await import("../db/index.js");
  const runningCount = getRunningSessions().length;

  if (runningCount >= config.maxParallel) {
    log.info(`Max parallel (${config.maxParallel}) reached, ${runningCount} running`);
    return 0;
  }

  // Collect all discovered (queued) issues across sources
  const candidates: IssueEntry[] = pollResults
    .flatMap((r) => r.discovered);

  // Sort by sourceId (for GitHub, lower number = older = higher priority)
  candidates.sort((a, b) => {
    const aNum = parseInt(a.sourceId, 10);
    const bNum = parseInt(b.sourceId, 10);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    return a.sourceId.localeCompare(b.sourceId);
  });

  let dispatched = 0;
  const slotsAvailable = config.maxParallel - runningCount;

  for (const candidate of candidates.slice(0, slotsAvailable)) {
    const { issue, sourceType, sourceId, targetRepo } = candidate;

    // Resolve plugin + context up front so the display name is available in logs
    const plugin = await resolvePlugin(sourceType);
    const ctx = buildSourceContextForRepo(targetRepo, log);
    const sourceName = plugin.name;

    // Resolve repo path for the worktree. ctx.repo is undefined when the repo
    // isn't declared in repos.json (config drift) — can't dispatch without a path.
    const repo = ctx.repo;
    if (!repo) {
      log.error(`Repo "${targetRepo}" not found for ${sourceName}:${sourceId}`);
      continue;
    }

    // Real-time state verification — guard against stale poll data. Only
    // dispatch issues still in the queued state.
    const current = await plugin.getStatus(ctx, sourceId);
    if (current.state !== "queued") {
      log.info(`Skipping ${sourceName}:${sourceId} — state is ${current.state ?? "null"}, not queued`);
      continue;
    }

    const session = tmux.sessionName(sourceType, targetRepo, sourceId);
    const prompt = buildPrompt(sourceId, issue.url, repo.path);

    // Write prompt to temp file to avoid shell escaping issues
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
      // Update status via plugin
      await plugin.transition(ctx, sourceId, { from: "queued", to: "processing" });
      if (plugin.onComment) {
        await plugin.onComment(ctx, sourceId, "🤖 Agent has started processing this issue...");
      }

      // Create tmux session
      tmux.createSession(session, command);

      // Record in DB
      updateIssueTmux(sourceType, sourceId, session);
      updateIssueStatus(sourceType, sourceId, "processing");
      createSession(issue.id, session);

      dispatched++;
    } catch (err: any) {
      log.error(`Failed to dispatch ${sourceName}:${sourceId}: ${err.message}`);
      await plugin.transition(ctx, sourceId, { from: "processing", to: "failed" });
    }
  }

  return dispatched;
}

/** Main dispatch cycle: check running + dispatch new */
export async function dispatch(pollResults: PollResult[]): Promise<DispatchResult> {
  const { completed, failed } = await checkRunningSessions();
  const dispatched = await dispatchNew(pollResults);
  const { getRunningSessions } = await import("../db/index.js");
  const runningCount = getRunningSessions().length;

  return {
    dispatched,
    completed,
    failed,
    idle: runningCount === 0 && dispatched === 0,
  };
}
