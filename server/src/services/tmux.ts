import { execSync } from "child_process";
import fs from "fs";

const SESSION_PREFIX = "tl";

/** Check that tmux is available */
export function checkTmux(): void {
  try {
    const ver = execSync("tmux -V", { timeout: 3_000, encoding: "utf-8" }).trim();
    console.log(`[tmux] ${ver}`);
  } catch {
    console.error("FATAL: tmux is not installed. Please install it first: sudo dnf install -y tmux");
    process.exit(1);
  }
}

/** Build a session name from repo name and issue number */
export function sessionName(repoName: string, issueNumber: number): string {
  return `${SESSION_PREFIX}-${repoName}-${issueNumber}`;
}

/** Create a new detached tmux session running a command */
export function createSession(name: string, command: string): void {
  execSync(`/usr/bin/tmux new-session -d -s "${name}" -x 200 -y 50 "${command}"`, { timeout: 10_000 });
}

/** Check if a tmux session is still alive */
export function isAlive(name: string): boolean {
  try {
    execSync(`/usr/bin/tmux has-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session */
export function killSession(name: string): void {
  try {
    execSync(`/usr/bin/tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
  } catch {
    // session already dead
  }
}

/** Capture the last N lines of a tmux session's output */
export function captureOutput(name: string, lines = 200): string {
  try {
    return execSync(`/usr/bin/tmux capture-pane -t "${name}" -p -S -${lines}`, {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch {
    return "";
  }
}

/** List all talos-loop managed sessions */
export function listManagedSessions(): string[] {
  try {
    const raw = execSync("/usr/bin/tmux list-sessions -F '#{session_name}'", {
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
