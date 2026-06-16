import { execSync } from "child_process";
import * as fs from "fs";
import os from "os";
import path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("tmux");

const SESSION_PREFIX = "tl";
/**
 * Prefix for the exit-code sentinel files each launcher writes to the tmp dir.
 * Combined with a session name this gives `/tmp/tl-exit-<tmux-session>.txt`
 * (issue #20: session status reflects exit state, not task outcome).
 */
const EXIT_CODE_PREFIX = "tl-exit";

/** Check that tmux is available */
export function checkTmux(): void {
  try {
    const ver = execSync("tmux -V", { timeout: 3_000, encoding: "utf-8" }).trim();
    log.info(ver);
  } catch {
    log.error("tmux is not installed. Please install it first: sudo dnf install -y tmux");
    process.exit(1);
  }
}

/**
 * Build a session name from the plugin alias (or source type), target repo, and
 * source ID. Each segment is sanitized so scoped package names (e.g.
 * "@alipay/talos-plugin-dima") and display names with spaces don't inject path
 * separators — the returned value is embedded in temp-file paths and tmux
 * session names, so it must be a flat, shell-safe identifier.
 */
export function sessionName(sourceName: string, targetRepo: string, sourceId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return [SESSION_PREFIX, safe(sourceName), safe(targetRepo), safe(sourceId)].join("-");
}

/** Create a new detached tmux session running a command */
export function createSession(name: string, command: string): void {
  execSync(`tmux new-session -d -s "${name}" -x 200 -y 50 "${command}"`, { timeout: 10_000 });
}

/** Check if a tmux session is still alive */
export function isAlive(name: string): boolean {
  try {
    execSync(`tmux has-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session */
export function killSession(name: string): void {
  try {
    execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
  } catch {
    // session already dead
  }
}

/** Capture the last N lines of a tmux session's output */
export function captureOutput(name: string, lines = 200): string {
  try {
    return execSync(`tmux capture-pane -t "${name}" -p -S -${lines}`, {
      encoding: "utf-8",
      timeout: 5_000,
    });
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
export function readExitCode(session: string): number | undefined {
  const file = exitCodePath(session);
  let code: number | undefined;
  try {
    const parsed = Number(fs.readFileSync(file, "utf-8").trim());
    code = Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    code = undefined;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // sentinel already absent — nothing to clean up
  }
  return code;
}

/** List all talos-loop managed sessions */
export function listManagedSessions(): string[] {
  try {
    const raw = execSync("tmux list-sessions -F '#{session_name}'", {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return raw.trim().split("\n").filter((s) => s.startsWith(SESSION_PREFIX + "-"));
  } catch {
    return [];
  }
}

/** Get the attach command for a session */
export function attachCommand(name: string): string {
  return `tmux attach -t ${name}`;
}
