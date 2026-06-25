import { promises as fsp, constants as fsConstants } from "fs";
import path from "path";
import { execAsync } from "../utils/execAsync.js";
import { createLogger } from "./logger.js";

const log = createLogger("worktree");

/**
 * The on-disk home of every talos-loop worktree (issue #21). Lives as a sibling
 * of each repo so worktrees are isolated from the repo working tree, discoverable
 * in one place, and persistent across restarts (NOT /tmp, which may be cleared —
 * a cleared worktree would defeat the "preserve for retry" guarantee).
 */
const WORKTREE_DIR = ".talos-worktrees";

/**
 * Deterministic worktree path for a session (issue #21). Derived from the repo
 * path + the (per-issue stable) tmux session name, so a retry for the SAME issue
 * resolves to the SAME path and reuses the worktree the failed session left on
 * disk — without the agent ever reporting the path back. Different issues map to
 * different paths (the session name carries the source id).
 */
export function worktreePath(repoPath: string, session: string): string {
  return path.join(path.dirname(path.resolve(repoPath)), WORKTREE_DIR, session);
}

async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { timeout: 30_000 });
}

/**
 * Create a fresh worktree + branch for a new coding session (issue #21), cut from
 * the remote baseline `origin/<baseBranch>` rather than local HEAD (issue #28) —
 * so the feat branch's starting point is the actual integration line (and its
 * current tip), not whatever happens to be checked out locally. The remote base is
 * fetched first so that tip is current. A stale path/branch from a prior issue
 * lifecycle (e.g. an issue reopened after its PR merged) is removed first so a
 * fresh dispatch always starts clean. Throws on a real git failure (including a
 * fetch failure) — the caller logs it and skips the dispatch.
 */
export async function createWorktree(repoPath: string, worktree: string, branch: string, baseBranch: string): Promise<void> {
  // Best-effort cleanup of a stale worktree and branch from a prior lifecycle.
  try {
    await run(`git -C "${repoPath}" worktree remove --force "${worktree}"`);
  } catch {
    // nothing stale at this path — expected on a fresh issue
  }
  try {
    await run(`git -C "${repoPath}" branch -D "${branch}"`);
  } catch {
    // branch absent — expected
  }
  // Fetch the remote baseline first so the feat branch starts from the current
  // tip of the integration line, not a stale local ref (issue #28). A fetch
  // failure throws and the caller skips the dispatch.
  await run(`git -C "${repoPath}" fetch origin "${baseBranch}"`);
  await run(`git -C "${repoPath}" worktree add -b "${branch}" "${worktree}" "origin/${baseBranch}"`);
  log.info(`Created worktree ${worktree} on branch ${branch} from origin/${baseBranch}`);
}

/**
 * Ensure the worktree exists for a retry (issue #21). The failed session's
 * worktree is normally still on disk — use it as-is. If it was removed out of
 * band (e.g. disk cleared), recreate it on the EXISTING branch so the prior
 * commits survive and the retry can continue from them.
 */
export async function ensureWorktree(repoPath: string, worktree: string, branch: string): Promise<void> {
  try {
    await fsp.access(worktree, fsConstants.F_OK);
    log.info(`Reusing preserved worktree ${worktree} on branch ${branch}`);
    return;
  } catch {
    // worktree doesn't exist — recreate it below
  }
  await run(`git -C "${repoPath}" worktree add "${worktree}" "${branch}"`);
  log.info(`Recreated missing worktree ${worktree} on existing branch ${branch}`);
}

/**
 * Remove a worktree (issue #21). Called as a safety net when a session SUCCEEDS
 * (exit 0 + pr_url) so a worktree the agent forgot to clean up doesn't leak disk
 * — the agent is still instructed to clean up, this just guarantees it. It is a
 * deliberate NO-OP on failure, where the worktree must remain for retry. Never
 * throws: a cleanup failure must not break the success finalization.
 */
export async function removeWorktree(repoPath: string, worktree: string): Promise<void> {
  try {
    await run(`git -C "${repoPath}" worktree remove --force "${worktree}"`);
    log.info(`Removed worktree ${worktree}`);
  } catch {
    // already gone (the agent cleaned up, or it was never created) — fine
  }
  try {
    await run(`git -C "${repoPath}" worktree prune`);
  } catch {
    // ignore — prune is best-effort metadata tidy-up
  }
}
