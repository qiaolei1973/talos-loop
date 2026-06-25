import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { execAsync } from "../utils/execAsync.js";
import { createLogger } from "./logger.js";

const log = createLogger("tmux");

const SESSION_PREFIX = "tl";
/**
 * Prefix for the exit-code sentinel files each launcher writes to the tmp dir.
 * Combined with a session name this gives `/tmp/tl-exit-<tmux-session>.txt`
 * (issue #20: session status reflects exit state, not task outcome).
 */
const EXIT_CODE_PREFIX = "tl-exit";
/**
 * Prefix for the Claude session-id sidecar the stream formatter writes (issue
 * #30). Gives `/tmp/tl-session-<tmux-session>.txt`. The formatter writes claude's
 * `-p` session id here at the stream's init event; the dispatcher reads it.
 */
const SESSION_ID_PREFIX = "tl-session";

/** Check that tmux is available */
export async function checkTmux(): Promise<void> {
  try {
    const { stdout } = await execAsync("tmux -V", { timeout: 3_000 });
    log.info(stdout.trim());
  } catch {
    log.error("tmux is not installed. Please install it first: sudo dnf install -y tmux");
    process.exit(1);
  }
}

/**
 * Build a session name from the plugin alias (or source type), target repo, and
 * source ID. Each segment is sanitized so scoped package names (e.g.
 * "@acme/source-jira") and display names with spaces don't inject path
 * separators — the returned value is embedded in temp-file paths and tmux
 * session names, so it must be a flat, shell-safe identifier.
 */
export function sessionName(sourceName: string, targetRepo: string, sourceId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return [SESSION_PREFIX, safe(sourceName), safe(targetRepo), safe(sourceId)].join("-");
}

/**
 * Build a review-session name (issue #19). A coding session and its review
 * cycles must not share a tmux name, so we suffix `-review`. The name is reused
 * across a single issue's review cycles: only one review session runs at a time
 * (dispatchReview skips when one is running), and a finished session's tmux
 * process has already exited, so the name is free again — `checkRunningSessions`
 * marks it done from the (dead) tmux state, never from name reuse.
 */
export function reviewSessionName(sourceName: string, targetRepo: string, sourceId: string): string {
  return `${sessionName(sourceName, targetRepo, sourceId)}-review`;
}

/** Create a new detached tmux session running a command */
export async function createSession(name: string, command: string): Promise<void> {
  await execAsync(`tmux new-session -d -s "${name}" -x 200 -y 50 "${command}"`, { timeout: 10_000 });
}

/** Check if a tmux session is still alive */
export async function isAlive(name: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session */
export async function killSession(name: string): Promise<void> {
  try {
    await execAsync(`tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
  } catch {
    // session already dead
  }
}

/** Capture the last N lines of a tmux session's output */
export async function captureOutput(name: string, lines = 200): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t "${name}" -p -S -${lines}`, {
      timeout: 5_000,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Path to the exit-code sentinel file a session's launcher writes immediately
 * after the `claude` process exits. Shared by the launcher (which writes it via
 * `echo $? >`) and {@link readExitCode} (which consumes it) so the two can never
 * disagree on the location (issue #20).
 */
export function exitCodePath(session: string): string {
  return path.join(os.tmpdir(), `${EXIT_CODE_PREFIX}-${session}.txt`);
}

/**
 * Read a finished session's exit code from its sentinel file, then delete the
 * file (the sentinel is single-use). Returns the code (0 = clean exit) or
 * `undefined` when the sentinel is absent — e.g. the process was killed
 * externally before the launcher could write it. A missing sentinel is the safe
 * "failed" signal: `checkRunningSessions` treats it as unclean termination
 * rather than guessing at success (issue #20).
 */
export async function readExitCode(session: string): Promise<number | undefined> {
  const file = exitCodePath(session);
  let code: number | undefined;
  try {
    const parsed = Number((await fsp.readFile(file, "utf-8")).trim());
    code = Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    code = undefined;
  }
  try {
    await fsp.unlink(file);
  } catch {
    // sentinel already absent — nothing to clean up
  }
  return code;
}

/**
 * Path to the Claude session-id sidecar the stream formatter writes (issue #30).
 * Shared by the formatter (which writes it via the `TL_SESSION_FILE` env the
 * launcher sets) and {@link readSessionId} (which consumes it) so the two agree.
 */
export function sessionIdPath(session: string): string {
  return path.join(os.tmpdir(), `${SESSION_ID_PREFIX}-${session}.txt`);
}

/**
 * Read the captured Claude session id from a session's sidecar, then delete it
 * (single-use, like {@link readExitCode}). Returns the id, or `undefined` when
 * the sidecar is absent — e.g. the formatter hasn't seen the init event yet, or
 * the run never produced one. The dispatcher persists the id the first cycle it
 * appears, so an absent sidecar on a later cycle simply means "already captured".
 */
export async function readSessionId(session: string): Promise<string | undefined> {
  const file = sessionIdPath(session);
  let id: string | undefined;
  try {
    const raw = (await fsp.readFile(file, "utf-8")).trim();
    id = raw.length > 0 ? raw : undefined;
  } catch {
    id = undefined;
  }
  try {
    await fsp.unlink(file);
  } catch {
    // sidecar already absent — nothing to clean up
  }
  return id;
}

/** List all talos-loop managed sessions */
export async function listManagedSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("tmux list-sessions -F '#{session_name}'", {
      timeout: 5_000,
    });
    return stdout.trim().split("\n").filter((s) => s.startsWith(SESSION_PREFIX + "-"));
  } catch {
    return [];
  }
}

/** Get the attach command for a session */
export function attachCommand(name: string): string {
  return `tmux attach -t ${name}`;
}
