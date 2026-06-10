import { execSync, exec } from "child_process";

const SESSION_PREFIX = "tl";

/** Build a tmux session name from repo name and issue number */
export function sessionName(repoName: string, issueNumber: number): string {
  return `${SESSION_PREFIX}-${repoName}-${issueNumber}`;
}

/** Create a new detached tmux session running a command */
export function createSession(name: string, command: string): void {
  execSync(`tmux new-session -d -s "${name}" "${command}"`, {
    timeout: 10_000,
  });
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

/** List all talos-loop managed sessions */
export function listManagedSessions(): string[] {
  try {
    const raw = execSync("tmux list-sessions -F '#{session_name}'", {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return raw
      .trim()
      .split("\n")
      .filter((s) => s.startsWith(SESSION_PREFIX + "-"));
  } catch {
    return [];
  }
}
