import * as fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, buildProjectContextForIssue, getProjectById } from "../config.js";
import {
  getRunningSessions,
  getRunningSessionsWithIssues,
  createSession,
  updateSessionStatus,
  setSessionClaudeId,
  getRunningReviewIssueIds,
  getIssue,
} from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { PollResult, IssueEntry } from "./poller.js";
import { setBoardStatus } from "./boardSnapshot.js";
import * as tmux from "./tmux.js";
import * as worktree from "./worktree.js";
import { createLogger } from "./logger.js";

const log = createLogger("dispatcher");

export interface DispatchResult {
  dispatched: number;
  completed: number;
  failed: number;
  /** review sessions spawned this cycle. */
  reviewed: number;
  /** coding sessions auto-retried via `claude -r` this cycle (issue #32). */
  retried: number;
  idle: boolean;
}

/** Minimal context the server injects into every launched skill via env. */
function buildEnv(parts: {
  issueUrl: string;
  sourceId: string;
  projectId: string;
  repoPath: string;
  targetRepo: string;
  branch: string;
}): Record<string, string> {
  return {
    TALOS_ISSUE_URL: parts.issueUrl,
    TALOS_SOURCE_ID: parts.sourceId,
    TALOS_PROJECT_ID: parts.projectId,
    TALOS_REPO_PATH: parts.repoPath,
    TALOS_TARGET_REPO: parts.targetRepo,
    TALOS_BRANCH: parts.branch,
  };
}

/**
 * The claude invocation for an initial skill dispatch (issue #32): invoke the
 * self-contained skill by name with the issue URL, in `-p` print +
 * stream-json mode (deterministic exit + session-id capture for `claude -r`).
 * The skill reads its full context from the TALOS_* env vars and drives itself;
 * it never calls back into the server.
 */
function buildSkillInvocation(skill: string, issueUrl: string): string {
  return `claude -p "/${skill} 处理 issue：${issueUrl}" --dangerously-skip-permissions --output-format=stream-json --verbose`;
}

/**
 * The claude invocation for an in-place retry (issue #32): resume the failed
 * session's conversation with `claude -r <id>` and a short "continue" prompt.
 * `-r` is combined with `-p` so the resume runs non-interactively (print mode)
 * and exits deterministically — a bare `claude -r` would block waiting for input
 * in the tmux pty. stream-json keeps it on the same formatter pipeline (and
 * harmlessly re-captures the same session id).
 */
function buildResumeInvocation(claudeSessionId: string): string {
  return `claude -r ${claudeSessionId} -p "上一次会话中途失败，请检查当前 worktree 的 git 状态（git status / log / diff），从当前进度继续完成该 issue" --dangerously-skip-permissions --output-format=stream-json --verbose`;
}

/**
 * Write the bash launcher that runs the given claude invocation, captures its
 * exit code to the sentinel (issue #20/#30), and self-deletes. Shared by
 * initial and retry dispatch. The invocation is piped through the stream
 * formatter (live readability + claude session-id capture) and teed to a raw
 * .jsonl; PIPESTATUS[0] takes claude's own exit (not node's). No pipefail — it
 * would pollute the sentinel with a downstream non-zero code.
 */
function launchScript(workDir: string, claudeInvocation: string, session: string, env: Record<string, string>): string {
  const exitCodeFile = tmux.exitCodePath(session);
  const sessionFile = tmux.sessionIdPath(session);
  const rawJsonl = path.join(os.tmpdir(), `tl-stream-${session}.jsonl`);
  // The formatter ships alongside this module (src in dev, dist in prod — the
  // build copies the .cjs verbatim), so resolve it relative to __dirname.
  const formatter = path.join(__dirname, "stream-formatter.cjs");
  const scriptFile = path.join(os.tmpdir(), `tl-run-${session}.sh`);
  const envLines = Object.entries(env).map(([k, v]) => `export ${k}="${v}"`);
  fs.writeFileSync(scriptFile, [
    `#!/bin/bash`,
    `cd ${workDir}`,
    `export TL_SESSION_FILE="${sessionFile}"`,
    ...envLines,
    `${claudeInvocation} 2>&1 | tee "${rawJsonl}" | node "${formatter}"`,
    `echo \${PIPESTATUS[0]} > "${exitCodeFile}"`,
    `rm -f "${scriptFile}"`,
  ].join("\n"), "utf-8");
  fs.chmodSync(scriptFile, 0o755);
  return scriptFile;
}

/**
 * Has a session exceeded the wall-clock limit (issue #30)? `started_at` is
 * SQLite `datetime('now')` (UTC without a trailing 'Z'); append 'Z' to parse as
 * UTC. Returns false for an unparseable/missing timestamp so a malformed row
 * never trips the watchdog kill.
 */
function isOverdue(startedAt: string | null | undefined, claudeTimeoutSeconds: number): boolean {
  if (!startedAt) return false;
  const start = Date.parse(startedAt.endsWith("Z") ? startedAt : startedAt + "Z");
  if (Number.isNaN(start)) return false;
  return Date.now() - start > claudeTimeoutSeconds * 1000;
}

/** Resolve the project's configured skill for a stage, or undefined if unset. */
function stageSkill(projectId: string, stage: string): string | undefined {
  return getProjectById(projectId)?.stages?.[stage];
}

/**
 * Check running sessions; for each that has exited, classify it (issue #32):
 *
 *   coding exit 0        → writeLabel(processing→done) + clean worktree + done
 *   coding crash, retriable → auto `claude -r` retry into the preserved worktree
 *   coding crash, exhausted  → failed + writeComment (if supported) + leave In progress
 *   review exit 0        → done (no board move) + clean worktree
 *   review crash         → failed + clean worktree (re-dispatched next cycle)
 *
 * The board advances ONLY on a clean coding exit — the deliberate stage move.
 * Everything else leaves the board alone (a crash parks the issue In progress).
 */
export async function checkRunningSessions(): Promise<{ completed: number; failed: number; retried: number }> {
  const running = getRunningSessionsWithIssues();
  const config = loadConfig();
  const keepSessionOnSuccess = config.keepSessionOnSuccess;
  let completed = 0;
  let failed = 0;
  let retried = 0;

  for (const { project_id, project_type, source_id, target_repo, ...session } of running) {
    const plugin = await resolvePlugin(project_type);
    const ctx = buildProjectContextForIssue(project_id, log);
    const sourceName = plugin.name;

    // Persist the captured claude session id as soon as the stream formatter
    // writes it to its sidecar (issue #30). Read every cycle, delete on first
    // sight; the id then lives in the DB, available mid-run and surviving a
    // crash, for `claude -r` resume.
    const claudeId = tmux.readSessionId(session.tmux_session);
    if (claudeId) setSessionClaudeId(session.id, claudeId);

    // Wall-clock watchdog: a hung agent would hold a slot forever. Kill it past
    // the limit; the kill leaves no exit sentinel → failed (id already captured).
    if (tmux.isAlive(session.tmux_session) && isOverdue(session.started_at, config.claudeTimeout)) {
      log.warn(`⏰ ${sourceName}:${source_id} exceeded claudeTimeout (${config.claudeTimeout}s) — killing`);
      tmux.killSession(session.tmux_session);
    }

    if (tmux.isAlive(session.tmux_session)) continue;

    const exitCode = tmux.readExitCode(session.tmux_session);
    const cleanExit = exitCode === 0;
    const captureTail = (): string => {
      const reason = exitCode === undefined
        ? "Session terminated unexpectedly (no exit-code sentinel)"
        : `Session exited with code ${exitCode}`;
      const lastOutput = tmux.captureOutput(session.tmux_session);
      return lastOutput.trim().slice(-500) || reason;
    };

    // --- review sessions: never advance the board, always clean their worktree ---
    if (session.type === "review") {
      removeSessionWorktree(ctx, session, target_repo);
      if (cleanExit) {
        log.info(`✅ ${sourceName}:${source_id} review session done`);
        updateSessionStatus(session.id, "done");
        if (!keepSessionOnSuccess) tmux.killSession(session.tmux_session);
        completed++;
      } else {
        // Review is implicitly retried: the next poll re-dispatches while review
        // subIssues remain unresolved, so a crash just records failed + cleans up.
        const tail = captureTail();
        log.warn(`⚠️ ${sourceName}:${source_id} review session failed — unresolved threads re-trigger next tick`);
        updateSessionStatus(session.id, "failed", tail);
        failed++;
      }
      continue;
    }

    // --- coding sessions ---
    if (cleanExit) {
      // Success: advance the stage processing→done (the ONLY board move) + clean up.
      log.info(`✅ ${sourceName}:${source_id} done — clean exit, advancing to In review`);
      updateSessionStatus(session.id, "done");
      if (!keepSessionOnSuccess) tmux.killSession(session.tmux_session);
      await plugin.writeLabel(ctx, source_id, { from: "processing", to: "done" }, target_repo);
      setBoardStatus(project_id, source_id, "done");
      removeSessionWorktree(ctx, session, target_repo);
      completed++;
    } else if (session.retry_count < config.maxRetry && session.claude_session_id) {
      // Auto-retry in place (issue #32): resume the failed conversation in the
      // preserved worktree via `claude -r`. The new running row records the
      // incremented retry chain; the failed row stays for history.
      log.info(`🔁 ${sourceName}:${source_id} retrying via claude -r (retry ${session.retry_count + 1}/${config.maxRetry})`);
      await retryCodingSession({
        sessionId: session.id,
        issueId: session.issue_id,
        projectId: project_id,
        projectType: project_type,
        sourceId: source_id,
        targetRepo: target_repo,
        worktreePath: session.worktree_path,
        branch: session.branch,
        retryCount: session.retry_count,
        claudeSessionId: session.claude_session_id,
        tail: captureTail(),
      });
      retried++;
    } else {
      // Exhausted retries (or no captured session id to resume): park the issue
      // In progress and, if the plugin supports it, leave a comment for a human.
      const tail = captureTail();
      const reason = exitCode === undefined ? "no exit-code sentinel" : `exit code ${exitCode}`;
      log.warn(`⚠️ ${sourceName}:${source_id} failed (${reason}, retries exhausted ${session.retry_count}/${config.maxRetry}) — leaving In progress`);
      updateSessionStatus(session.id, "failed", tail);
      if (plugin.writeComment) {
        await plugin.writeComment(
          ctx,
          source_id,
          `⚠️ Agent session failed (${reason}) and exhausted retries (${session.retry_count}/${config.maxRetry}). Issue left In progress for investigation.\n\n\`\`\`\n${tail}\n\`\`\``,
          target_repo,
        );
      }
      failed++;
    }
  }

  return { completed, failed, retried };
}

/** Remove a session's worktree (best-effort; never throws). */
function removeSessionWorktree(
  ctx: { repos: Array<{ name: string; path: string }> },
  session: { worktree_path: string | null },
  targetRepo: string,
): void {
  if (!session.worktree_path) return;
  const repoPath = ctx.repos.find((r) => r.name === targetRepo)?.path;
  if (repoPath) worktree.removeWorktree(repoPath, session.worktree_path);
}

/**
 * Retry a crashed coding session by resuming its claude conversation in the
 * preserved worktree. Reuses the per-issue coding session name (the dead tmux
 * process freed it) and worktree path; marks the failed row terminal and starts
 * a fresh running row with the incremented retry_count.
 */
async function retryCodingSession(args: {
  sessionId: number;
  issueId: number;
  projectId: string;
  projectType: string;
  sourceId: string;
  targetRepo: string;
  worktreePath: string | null;
  branch: string | null;
  retryCount: number;
  claudeSessionId: string;
  tail: string;
}): Promise<void> {
  const { sessionId, issueId, projectId, projectType, sourceId, targetRepo, worktreePath, branch, retryCount, claudeSessionId, tail } = args;
  if (!worktreePath || !branch) {
    log.error(`retry ${sourceId}: missing worktree/branch — cannot retry in place`);
    updateSessionStatus(sessionId, "failed", tail);
    return;
  }

  const plugin = await resolvePlugin(projectType);
  const ctx = buildProjectContextForIssue(projectId, log);
  const sourceName = plugin.name;
  const repo = ctx.repos.find((r) => r.name === targetRepo);
  if (!repo) throw new Error(`Repo "${targetRepo}" not found for retry of ${sourceName}:${sourceId}`);

  worktree.ensureWorktree(repo.path, worktreePath, branch);

  const session = tmux.sessionName(sourceName, targetRepo, sourceId);
  const issueUrl = getIssue(projectId, sourceId)?.url ?? "";
  const invocation = buildResumeInvocation(claudeSessionId);
  const env = buildEnv({ issueUrl, sourceId, projectId, repoPath: repo.path, targetRepo, branch });
  const command = launchScript(worktreePath, invocation, session, env);

  // Mark the crashed row terminal, then start the retry as a fresh running row.
  updateSessionStatus(sessionId, "failed", tail);
  tmux.createSession(session, command);
  createSession(issueId, session, { type: "coding", branch, worktreePath, retryCount: retryCount + 1 });
}

/** Dispatch queued issues: create a worktree, advance to processing, launch the ready-stage skill. */
export async function dispatchNew(pollResults: PollResult[]): Promise<number> {
  const config = loadConfig();
  const runningCount = getRunningSessions().length;

  if (runningCount >= config.maxParallel) {
    log.info(`Max parallel (${config.maxParallel}) reached, ${runningCount} running`);
    return 0;
  }

  const candidates: IssueEntry[] = pollResults
    .flatMap((r) => r.discovered)
    .filter((c) => c.state === "queued");

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
    if (dispatched >= slotsAvailable) break;
    const { issue, projectId, projectType, sourceId, targetRepo } = candidate;

    const skill = stageSkill(projectId, "ready");
    if (!skill) {
      log.warn(`No "ready" stage skill configured for ${projectId} — skipping ${sourceId}`);
      continue;
    }

    const plugin = await resolvePlugin(projectType);
    const ctx = buildProjectContextForIssue(projectId, log);
    const sourceName = plugin.name;

    const repo = ctx.repos.find((r) => r.name === targetRepo);
    if (!repo) {
      log.error(`Repo "${targetRepo}" not found for ${sourceName}:${sourceId}`);
      continue;
    }

    // Real-time freshness check — only dispatch issues still actionable.
    if (plugin.getItem) {
      const current = await plugin.getItem(ctx, sourceId, targetRepo);
      if (current.state !== "queued") {
        log.info(`Skipping ${sourceName}:${sourceId} — not actionable (state ${current.state ?? "null"})`);
        continue;
      }
    }

    const session = tmux.sessionName(sourceName, targetRepo, sourceId);
    const branch = `feat/issue-${sourceId}`;
    const worktreePath = worktree.worktreePath(repo.path, session);
    try {
      // Cut the feat branch from the repo's declared baseline (default "main").
      worktree.createWorktree(repo.path, worktreePath, branch, repo.branch ?? "main");
    } catch (err: any) {
      log.error(`Failed to create worktree for ${sourceName}:${sourceId}: ${err.message}`);
      continue;
    }

    const invocation = buildSkillInvocation(skill, issue.url);
    const env = buildEnv({ issueUrl: issue.url, sourceId, projectId, repoPath: repo.path, targetRepo, branch });
    const command = launchScript(worktreePath, invocation, session, env);

    log.info(`🚀 Dispatching ${sourceName}:${sourceId} → session ${session} (skill ${skill}, worktree ${worktreePath})`);

    try {
      await plugin.writeLabel(ctx, sourceId, { from: "queued", to: "processing" }, targetRepo);

      tmux.createSession(session, command);

      createSession(issue.id, session, { type: "coding", branch, worktreePath });
      // Optimistically flip the snapshot to processing so the dashboard reflects
      // dispatch before the next poll re-reads the board.
      setBoardStatus(projectId, sourceId, "processing");

      dispatched++;
    } catch (err: any) {
      log.error(`Failed to dispatch ${sourceName}:${sourceId}: ${err.message}`);
      // Drop the unused worktree so it doesn't leak, and roll the board back.
      worktree.removeWorktree(repo.path, worktreePath);
      await plugin.writeLabel(ctx, sourceId, { from: "processing", to: "queued" }, targetRepo);
    }
  }

  return dispatched;
}

/**
 * Dispatch the review skill for in-review (done) issues that carry an unresolved
 * `review` subIssue (issue #32). The board is NOT touched: review is a perpetual
 * worker on a PR that is already "In review", and GitHub's automation advances
 * it to Done on merge. Reuses the per-issue review session name + worktree on
 * the existing feat branch (the PR head). One review session per issue at a time.
 */
export async function dispatchReview(pollResults: PollResult[]): Promise<number> {
  const candidates: IssueEntry[] = pollResults
    .flatMap((r) => r.discovered)
    .filter(
      (c) => c.state === "done" && (c.subIssues?.some((s) => s.type === "review" && !s.resolved) ?? false),
    );
  if (candidates.length === 0) return 0;

  const runningReview = getRunningReviewIssueIds();
  let reviewed = 0;

  for (const candidate of candidates) {
    const { issue, projectId, projectType, sourceId, targetRepo } = candidate;

    if (runningReview.has(issue.id)) {
      log.info(`Skipping review for ${sourceId} — a review session is already running`);
      continue;
    }

    const skill = stageSkill(projectId, "in-review");
    if (!skill) {
      // No review skill configured — nothing to do for this stage.
      continue;
    }

    const plugin = await resolvePlugin(projectType);
    const ctx = buildProjectContextForIssue(projectId, log);
    const sourceName = plugin.name;
    const repo = ctx.repos.find((r) => r.name === targetRepo);
    if (!repo) {
      log.error(`Repo "${targetRepo}" not found for review of ${sourceName}:${sourceId}`);
      continue;
    }

    const branch = `feat/issue-${sourceId}`;
    const session = tmux.reviewSessionName(sourceName, targetRepo, sourceId);
    const worktreePath = worktree.worktreePath(repo.path, session);
    try {
      // Reuse/recreate the worktree on the existing PR head branch.
      worktree.ensureWorktree(repo.path, worktreePath, branch);
    } catch (err: any) {
      log.error(`Failed to ensure review worktree for ${sourceName}:${sourceId}: ${err.message}`);
      continue;
    }

    const invocation = buildSkillInvocation(skill, issue.url);
    const env = buildEnv({ issueUrl: issue.url, sourceId, projectId, repoPath: repo.path, targetRepo, branch });
    const command = launchScript(worktreePath, invocation, session, env);

    log.info(`🔧 Dispatching review for ${sourceName}:${sourceId} → session ${session} (skill ${skill})`);

    try {
      tmux.createSession(session, command);
      createSession(issue.id, session, { type: "review", branch, worktreePath });
      reviewed++;
      runningReview.add(issue.id);
    } catch (err: any) {
      log.error(`Failed to dispatch review for ${sourceName}:${sourceId}: ${err.message}`);
    }
  }

  return reviewed;
}

/** Main dispatch cycle: check running + dispatch new + dispatch review */
export async function dispatch(pollResults: PollResult[]): Promise<DispatchResult> {
  const { completed, failed, retried } = await checkRunningSessions();
  const dispatched = await dispatchNew(pollResults);
  // Review is driven by the subIssue signal in list() every cycle (guarded by
  // the one-review-session-per-issue rule), so no slow cadence counter.
  const reviewed = await dispatchReview(pollResults);

  const runningCount = getRunningSessions().length;

  return {
    dispatched,
    completed,
    failed,
    reviewed,
    retried,
    idle: runningCount === 0 && dispatched === 0 && reviewed === 0,
  };
}
