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
import * as worktree from "./worktree.js";
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
  worktreePath: string,
  branch: string,
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
    `- 在已为你创建好的 git worktree 中工作（不要自行新建 worktree 或分支）`,
    `  - worktree 路径：${worktreePath}`,
    `  - 分支：${branch}`,
    `  - 进入工作目录：cd ${worktreePath}`,
    `- 在 worktree 中完成所有开发工作`,
    `- 完成后提交代码并推送分支 ${branch}，再调用 submit-pr 操作创建关联 Issue 的 Pull Request（传入分支名 ${branch}）`,
    `- 最后清理 worktree：cd ${repoPath} && git worktree remove ${worktreePath}`,
    ``,
    `与 talos-loop 通信（POST ${actionsBase}/{action}，JSON body 含 targetRepo: "${targetRepo}"）：`,
    ...actionLines.map((line) => `    ${line}`),
  ].join("\n");
}

/**
 * Write the agent prompt to a tmp file and the bash launcher that runs `claude`
 * on it, captures the exit code to the sentinel (issue #20), then self-deletes.
 * Shared by coding and review dispatch so both record the same exit-state
 * signal that {@link checkRunningSessions} reads. `workDir` is the directory the
 * agent starts in: a coding session's pre-created worktree (issue #21), or the
 * repo path for a review session (which spins up its own worktree).
 */
function launchScript(workDir: string, prompt: string, session: string): string {
  const promptFile = path.join(os.tmpdir(), `tl-prompt-${session}.txt`);
  fs.writeFileSync(promptFile, prompt, "utf-8");
  const exitCodeFile = tmux.exitCodePath(session);
  const scriptFile = path.join(os.tmpdir(), `tl-run-${session}.sh`);
  fs.writeFileSync(scriptFile, [
    `#!/bin/bash`,
    `cd ${workDir}`,
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
 * Build the retry prompt (issue #21). Differs from the initial coding prompt in
 * one key way: instead of "create a new worktree and branch", it tells the agent
 * a worktree already exists at `<worktree>` on branch `<branch>` with partial
 * work, and to continue from the current state, complete the implementation, and
 * submit a PR. Full issue context is supplied, so this is a fresh Claude run (no
 * `--resume`) that picks up from the on-disk work the failed session left behind.
 */
function buildRetryPrompt(
  sourceId: string,
  url: string,
  repoPath: string,
  worktreePath: string,
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
    `你是一个自动化编码代理。上一次针对该 Issue 的实现会话中途失败，但已完成的工作保存在一个现成的 git worktree 中。请从当前状态继续，完成实现并提交 PR。`,
    ``,
    `Issue: ${url}`,
    ``,
    `环境（已就绪，不要新建 worktree 或分支）：`,
    `- worktree 路径：${worktreePath}`,
    `- 分支：${branch}`,
    ``,
    `流程：`,
    `- 进入工作目录：cd ${worktreePath}`,
    `- 用 git log / git status / git diff 检查已完成的工作，理解当前进度`,
    `- 阅读并理解 issue 内容，继续完成未完成的实现`,
    `- 完成后提交并推送分支 ${branch}，再调用 submit-pr 操作创建关联 Issue 的 Pull Request（传入分支名 ${branch}）`,
    `- 最后清理 worktree：cd ${repoPath} && git worktree remove ${worktreePath}`,
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
  // issue #26: a successfully-completed (exit-0) session's tmux window is torn
  // down unless the operator opts into keep-alive. Loaded once per cycle (cached).
  const { keepSessionOnSuccess } = loadConfig();
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
        // issue #26: completed review session — tear down its tmux window.
        if (!keepSessionOnSuccess) tmux.killSession(session.tmux_session);
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
      // issue #26: completed session — tear down its tmux window (opt out via
      // keepSessionOnSuccess). Done before the board transition so a slow GitHub
      // call can't delay the local cleanup.
      if (!keepSessionOnSuccess) tmux.killSession(session.tmux_session);
      await plugin.transition(ctx, source_id, { from: "processing", to: "done" }, target_repo);
      if (plugin.onComment) {
        await plugin.onComment(ctx, source_id, `✅ Agent completed. PR: ${session.pr_url}`, target_repo);
      }
      // Optimistically mirror the board move (processing → "In review") so the
      // dashboard shows done before the next poll re-reads the board.
      setBoardStatus(project_id, source_id, "In review");
      // issue #21: success safety-net — remove the worktree so a leak the agent
      // forgot to clean up doesn't accumulate. (The failure branch below does NOT
      // do this: the worktree stays on disk for a manual retry.)
      if (session.worktree_path) {
        const repoPath = ctx.repos.find((r) => r.name === target_repo)?.path;
        if (repoPath) worktree.removeWorktree(repoPath, session.worktree_path);
      }
      completed++;
    } else if (cleanExit) {
      // Clean exit but no PR — a coding agent that chose not to submit. The
      // session ran successfully, so it is `done`; the board is left untouched
      // because only an explicit submit-pr/skip advances it. (Review sessions are
      // handled by the type === 'review' branch above and never reach here.)
      log.info(`✅ ${sourceName}:${source_id} done — exited cleanly with no PR (board left In progress)`);
      updateSessionStatus(session.id, "done", undefined);
      // issue #26: a clean exit is still "completed" — tear down the tmux window.
      if (!keepSessionOnSuccess) tmux.killSession(session.tmux_session);
      completed++;
    } else {
      // Non-zero exit OR missing sentinel → infrastructure failure. The board is
      // intentionally left "In progress" so a developer notices and investigates
      // (issue #20) — it is no longer auto-rolled back to Ready, and prior work
      // (commits, worktree state) is preserved. The error tail is surfaced in the
      // dashboard only; no comment is posted. The worktree is deliberately LEFT on
      // disk (issue #21): no removeWorktree() here, so a manual retry can resume it.
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

    // issue #21: the worktree path and branch are server-determined (derived
    // from the per-issue session name), so the path is known to the server
    // without the agent reporting back, and a later retry resolves to the same
    // path. The worktree is created BEFORE launch so the agent starts inside it.
    const branch = `feat/issue-${sourceId}`;
    const worktreePath = worktree.worktreePath(repo.path, session);
    try {
      worktree.createWorktree(repo.path, worktreePath, branch);
    } catch (err: any) {
      log.error(`Failed to create worktree for ${sourceName}:${sourceId}: ${err.message}`);
      continue;
    }

    const capabilities = pluginCapabilities(plugin);
    const prompt = buildPrompt(sourceId, issue.url, repo.path, projectId, config.serverBaseUrl, targetRepo, capabilities, worktreePath, branch);

    // Launch the agent INSIDE the worktree (issue #21).
    const command = launchScript(worktreePath, prompt, session);

    log.info(`🚀 Dispatching ${sourceName}:${sourceId} → session ${session} (worktree ${worktreePath})`);

    try {
      await plugin.transition(ctx, sourceId, { from: "queued", to: "processing" }, targetRepo);
      if (plugin.onComment) {
        await plugin.onComment(ctx, sourceId, "🤖 Agent has started processing this issue...", targetRepo);
      }

      tmux.createSession(session, command);

      createSession(issue.id, session, { worktreePath, branch });
      // Optimistically flip the board snapshot to "In progress" so the dashboard
      // reflects processing between this dispatch and the next poll (issue #13).
      setBoardStatus(projectId, sourceId, "In progress");

      dispatched++;
    } catch (err: any) {
      log.error(`Failed to dispatch ${sourceName}:${sourceId}: ${err.message}`);
      // The worktree was created before this try block — if the dispatch failed
      // after that point, drop the unused worktree so it doesn't leak (issue #21).
      worktree.removeWorktree(repo.path, worktreePath);
      // Roll the board status back to Ready so the next poll retries.
      await plugin.transition(ctx, sourceId, { from: "processing", to: "queued" }, targetRepo);
    }
  }

  return dispatched;
}

/**
 * Retry a failed session in place (issue #21): dispatch a fresh coding agent
 * directly into the worktree and branch the failed session left on disk, with a
 * prompt that says "continue from here" rather than "start over".
 *
 * The new session record inherits the failed session's `issue_id`, `branch`, and
 * `worktree_path`. The failed record is left as-is (`status = 'failed'`) — the
 * retry shows up as a separate, newer row in the issue's session group. The
 * board is NOT touched: the issue stays "In progress" (the failed session left
 * it there per issue #20), and a successful retry advances it to "In review" via
 * the normal submit-pr → checkRunningSessions path.
 *
 * The caller ({@link getRetryableSession}) guarantees `failed` is the issue's
 * latest session and is a failed coding session with a recorded worktree+branch.
 */
export async function dispatchRetry(
  failed: { issue_id: number; project_id: string; project_type: string; source_id: string; target_repo: string; url: string; worktree_path: string; branch: string },
): Promise<void> {
  const config = loadConfig();
  const { issue_id, project_id, project_type, source_id, target_repo, url, worktree_path, branch } = failed;

  const plugin = await resolvePlugin(project_type);
  const ctx = buildProjectContextForIssue(project_id, log);
  const sourceName = plugin.name;
  const repo = ctx.repos.find((r) => r.name === target_repo);
  if (!repo) throw new Error(`Repo "${target_repo}" not found for retry of ${sourceName}:${source_id}`);

  // Reuse the preserved worktree (recreate it on the existing branch if it was
  // removed out of band) so the partial work the failed session committed survives.
  worktree.ensureWorktree(repo.path, worktree_path, branch);

  // Same per-issue session name as the original coding dispatch → reuses the same
  // worktree path derivation and (free-again) tmux name; the failed session's
  // tmux process is dead by the time its status is 'failed'.
  const session = tmux.sessionName(sourceName, target_repo, source_id);
  const capabilities = pluginCapabilities(plugin);
  const prompt = buildRetryPrompt(source_id, url, repo.path, worktree_path, branch, project_id, config.serverBaseUrl, target_repo, capabilities);
  // Launch the agent INSIDE the existing worktree.
  const command = launchScript(worktree_path, prompt, session);

  log.info(`🔁 Retrying ${sourceName}:${source_id} in existing worktree ${worktree_path} → session ${session}`);

  tmux.createSession(session, command);
  // Inherit issue_id, branch, AND worktree_path from the failed session; a fresh
  // 'running' coding row that the dashboard shows alongside the failed one.
  createSession(issue_id, session, { type: "coding", branch, worktreePath: worktree_path });
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
