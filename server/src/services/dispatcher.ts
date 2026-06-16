import * as fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, buildProjectContextForIssue } from "../config.js";
import {
  getRunningSessions,
  getRunningSessionsWithIssues,
  createSession,
  updateSessionStatus,
  getCodingSessionsWithPr,
  getRunningReviewIssueIds,
} from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { IssueSourcePlugin, PluginCapability } from "../types/plugin.js";
import type { PollResult, IssueEntry } from "./poller.js";
import { setBoardStatus, getBoardStatus } from "./boardSnapshot.js";
import { norm } from "./displayState.js";
import * as tmux from "./tmux.js";
import { createLogger } from "./logger.js";

const log = createLogger("dispatcher");

export interface DispatchResult {
  dispatched: number;
  completed: number;
  failed: number;
  /** issue #19: review sessions spawned this cycle. */
  reviewed: number;
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
 * Write the agent prompt to a tmp file and the bash launcher that runs `claude`
 * on it, captures the exit code to the sentinel (issue #20), then self-deletes.
 * Shared by coding and review dispatch so both record the same exit-state
 * signal that {@link checkRunningSessions} reads.
 */
function launchScript(repoPath: string, prompt: string, session: string): string {
  const promptFile = path.join(os.tmpdir(), `tl-prompt-${session}.txt`);
  fs.writeFileSync(promptFile, prompt, "utf-8");
  const exitCodeFile = tmux.exitCodePath(session);
  const scriptFile = path.join(os.tmpdir(), `tl-run-${session}.sh`);
  fs.writeFileSync(scriptFile, [
    `#!/bin/bash`,
    `cd ${repoPath}`,
    `claude "$(cat ${promptFile})" --dangerously-skip-permissions`,
    `echo $? > "${exitCodeFile}"`,
    `rm -f "${scriptFile}" "${promptFile}"`,
  ].join("\n"), "utf-8");
  fs.chmodSync(scriptFile, 0o755);
  return scriptFile;
}

/**
 * Build the review-fix prompt (issue #19). The agent self-drives a loop: fetch
 * the PR's unresolved review threads, fix each, push to the original PR branch,
 * resolve each thread via the `resolve-thread` action, then re-check for any
 * threads the reviewer added mid-cycle, repeating until none remain. Full
 * context (PR url, branch, threads) is supplied every run — no resume needed.
 */
function buildReviewPrompt(
  sourceId: string,
  prUrl: string,
  repoPath: string,
  branch: string,
  projectId: string,
  serverBaseUrl: string,
  targetRepo: string,
  capabilities: PluginCapability[],
): string {
  const encodedProject = encodeURIComponent(projectId);
  const actionsBase = `${serverBaseUrl}/api/projects/${encodedProject}/issues/${sourceId}/actions`;
  const actionLines = capabilities.map((cap) => {
    const params = cap.params.map((p) => p.name).join(", ");
    return `- ${cap.action}：${cap.description}${params ? ` | 参数：${params}` : ""}`;
  });
  return [
    `你是一个自动化代码评审修复代理。请根据 PR "${prUrl}" 的评审意见修复代码。`,
    ``,
    `目标：解决该 PR 上所有未解决（unresolved）的评审线程（review threads），让评审可以继续。`,
    ``,
    `参数：`,
    `- 工作仓库：${repoPath}`,
    `- PR 地址：${prUrl}`,
    `- 目标分支（把修复推送到此分支）：${branch}`,
    ``,
    `流程（循环直到没有未解决线程）：`,
    `1. 从 PR 地址推导 PR 编号（地址末尾的数字）`,
    `2. 在仓库 ${repoPath} 下基于分支 ${branch} 创建 git worktree（自行决定 worktree 路径）`,
    `3. 用 \`gh pr view <PR编号> --json reviewThreads\` 等方式获取所有「未解决」的评审线程`,
    `4. 针对每个未解决线程修复代码`,
    `5. 提交并推送到分支 ${branch}（不要新建分支，保持 PR 历史连续）`,
    `6. 对每个已处理的线程调用 resolve-thread 操作（传入该线程的 threadId 和 prUrl="${prUrl}"），将其标记为已解决`,
    `7. 重新获取评审线程；如果仍有「未解决」的（包括评审者在修复期间新提出的），回到第 4 步`,
    `8. 如果全部已解决，清理 worktree 并退出：cd ${repoPath} && git worktree remove <你的worktree路径>`,
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

    const plugin = await resolvePlugin(project_type);
    const ctx = buildProjectContextForIssue(project_id, log);
    const sourceName = plugin.name;

    // issue #19: review sessions are fire-and-retire workers on a PR that is
    // already "In review". They never advance the board and never post a
    // completion comment — the stage is perpetual and board-driven, so the next
    // poll cycle re-checks for still-unresolved threads (implicit retry). They
    // DO carry a pr_url (written at dispatch), so they must be split off BEFORE
    // the coding success-path that keys off pr_url.
    if (session.type === "review") {
      const exitCode = tmux.readExitCode(session.tmux_session);
      if (exitCode === 0) {
        log.info(`✅ ${sourceName}:${source_id} review session done — ${session.pr_url}`);
        updateSessionStatus(session.id, "done", session.pr_url);
        completed++;
      } else {
        const reason = exitCode === undefined
          ? "Review session terminated unexpectedly (no exit-code sentinel)"
          : `Review session exited with code ${exitCode}`;
        const lastOutput = tmux.captureOutput(session.tmux_session);
        const tail = lastOutput.trim().slice(-500) || reason;
        log.warn(`⚠️ ${sourceName}:${source_id} ${reason} — unresolved threads remain; next review tick retries`);
        updateSessionStatus(session.id, "failed", undefined, tail);
        failed++;
      }
      continue; // no board transition, no comment — stage stays "In review"
    }


    // Sessions skipped or completed via the HTTP API are no longer 'running'
    // (skip → 'skipped'; submit-pr leaves status 'running' but records pr_url).
    // The exit-code sentinel written by the launcher is the source of truth for
    // clean vs. crashed termination; a missing sentinel means the process was
    // killed before it could record one → treat as a failure (issue #20).
    const exitCode = tmux.readExitCode(session.tmux_session);
    const cleanExit = exitCode === 0;

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
      // Clean exit but no PR — a coding agent that chose not to submit. The
      // session ran successfully, so it is `done`; the board is left untouched
      // because only an explicit submit-pr/skip advances it. (Review sessions are
      // handled by the type === 'review' branch above and never reach here.)
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

    const command = launchScript(repo.path, prompt, session);

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

/**
 * Spawn review-fix sessions for PRs with unresolved review threads (issue #19).
 * Runs on a slow counter (every Nth dispatch cycle) so a reviewer can batch
 * several rounds of "Request changes" comments before the agent acts. Reuses
 * the serial-dispatch guarantee: an issue with a running review session is
 * skipped, so no two agents ever work the same PR branch at once.
 *
 * For each coding session that has a PR:
 *   1. confirm the board still reads "In review" (perpetual stage);
 *   2. skip if a review session is already running for the issue;
 *   3. skip if the plugin can't inspect review threads, or has none unresolved;
 *   4. otherwise dispatch a fresh review session on a worktree, pushing to the
 *      PR's head branch, with the PR url + branch recorded up front.
 * Returns the number of review sessions spawned. Never throws — a failure to
 * inspect or dispatch one PR does not abort the rest.
 */
export async function dispatchReview(): Promise<number> {
  const config = loadConfig();
  const candidates = getCodingSessionsWithPr();
  if (candidates.length === 0) return 0;

  const runningReview = getRunningReviewIssueIds();
  let reviewed = 0;

  for (const { project_id, project_type, source_id, target_repo, ...coding } of candidates) {
    const issueId = coding.issue_id;

    // (1) Still "In review" on the board? A merged (Done) or rolled-back PR has
    // no review work for us; the stage is the source of truth here.
    if (norm(getBoardStatus(project_id, source_id) ?? "") !== "inreview") continue;

    // (2) One review session per issue at a time.
    if (runningReview.has(issueId)) {
      log.info(`Skipping review for ${source_id} — a review session is already running`);
      continue;
    }

    const plugin = await resolvePlugin(project_type);
    if (typeof plugin.listUnresolvedThreads !== "function") continue; // plugin can't inspect reviews

    const ctx = buildProjectContextForIssue(project_id, log);
    const sourceName = plugin.name;
    const branch = coding.branch;
    if (!branch) {
      log.warn(`Skipping review for ${sourceName}:${source_id} — coding session has no recorded branch`);
      continue;
    }

    // (3) Unresolved threads? This also batches a reviewer's multiple rounds:
    // the agent runs once against the full set present at this tick.
    let threads;
    try {
      threads = await plugin.listUnresolvedThreads(ctx, coding.pr_url!);
    } catch (err: any) {
      log.warn(`Review probe failed for ${sourceName}:${source_id}: ${err.message}`);
      continue;
    }
    if (threads.length === 0) continue;

    const repo = ctx.repos.find((r) => r.name === target_repo);
    if (!repo) {
      log.error(`Repo "${target_repo}" not found for review of ${sourceName}:${source_id}`);
      continue;
    }

    const session = tmux.reviewSessionName(sourceName, target_repo, source_id);
    const capabilities = pluginCapabilities(plugin);
    const prompt = buildReviewPrompt(source_id, coding.pr_url!, repo.path, branch, project_id, config.serverBaseUrl, target_repo, capabilities);
    const command = launchScript(repo.path, prompt, session);

    log.info(`🔧 Dispatching review for ${sourceName}:${source_id} (${threads.length} thread(s)) → session ${session}`);

    try {
      tmux.createSession(session, command);
      // PR already exists → record its url + branch up front (not via callback).
      createSession(issueId, session, { type: "review", branch, prUrl: coding.pr_url! });
      reviewed++;
      // Track it so a later candidate in the same tick (same issue) is skipped.
      runningReview.add(issueId);
    } catch (err: any) {
      log.error(`Failed to dispatch review for ${sourceName}:${source_id}: ${err.message}`);
    }
  }

  return reviewed;
}

// issue #19: dispatchReview() fires every Nth dispatch cycle, not every cycle,
// giving a reviewer time to batch review comments before the agent runs.
// Module-level (not persisted) — resets on restart, which is fine.
let reviewTick = 0;

/** Reset the review tick counter (test helper). */
export function resetReviewTick(): void {
  reviewTick = 0;
}

/** Main dispatch cycle: check running + dispatch new (+ review on a slow tick) */
export async function dispatch(pollResults: PollResult[]): Promise<DispatchResult> {
  const { completed, failed } = await checkRunningSessions();
  const dispatched = await dispatchNew(pollResults);

  // Slow review cadence: fire dispatchReview() once every Nth cycle. Independent
  // of dispatchNew() so a review tick still runs when there are no new issues.
  const reviewEvery = loadConfig().reviewDispatchEvery;
  let reviewed = 0;
  reviewTick++;
  if (reviewTick >= reviewEvery) {
    reviewTick = 0;
    reviewed = await dispatchReview();
  }

  const runningCount = getRunningSessions().length;

  return {
    dispatched,
    completed,
    failed,
    reviewed,
    idle: runningCount === 0 && dispatched === 0 && reviewed === 0,
  };
}
