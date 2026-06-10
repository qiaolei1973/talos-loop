import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const SESSION_PREFIX = "tl";

const hasTmux = (() => {
  try {
    execSync("which tmux", { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

/** Directory for PID files and logs when tmux is not available */
function runDir(): string {
  const dir = path.resolve(process.cwd(), "server/data/run");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a session name from repo name and issue number */
export function sessionName(repoName: string, issueNumber: number): string {
  return `${SESSION_PREFIX}-${repoName}-${issueNumber}`;
}

/** Create a new detached session running a command */
export function createSession(name: string, command: string): void {
  const dir = runDir();

  if (hasTmux) {
    execSync(`tmux new-session -d -s "${name}" ${command}`, { timeout: 10_000 });
  } else {
    // Use nohup + background process with PID tracking
    const pidFile = path.join(dir, `${name}.pid`);
    execSync(`nohup ${command} & echo $! > ${pidFile}`, {
      timeout: 10_000,
      shell: "/bin/bash",
      stdio: "ignore",
    });
  }
}

/** Check if a session is still alive */
export function isAlive(name: string): boolean {
  if (hasTmux) {
    try {
      execSync(`tmux has-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  } else {
    // Check PID file
    const pidFile = path.join(runDir(), `${name}.pid`);
    if (!fs.existsSync(pidFile)) return false;
    const pid = fs.readFileSync(pidFile, "utf-8").trim();
    if (!pid) return false;
    try {
      // Signal 0 = check if process exists
      process.kill(parseInt(pid, 10), 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** Kill a session */
export function killSession(name: string): void {
  if (hasTmux) {
    try {
      execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 5_000 });
    } catch {
      // session already dead
    }
  } else {
    const pidFile = path.join(runDir(), `${name}.pid`);
    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, "utf-8").trim();
      try {
        process.kill(parseInt(pid, 10), "SIGTERM");
      } catch {
        // already dead
      }
      fs.unlinkSync(pidFile);
    }
  }
}

/** Capture output (for nohup mode, returns empty — use log file instead) */
export function captureOutput(name: string, _lines = 200): string {
  if (hasTmux) {
    try {
      return execSync(`tmux capture-pane -t "${name}" -p -S -${_lines}`, {
        encoding: "utf-8",
        timeout: 5_000,
      });
    } catch {
      return "";
    }
  }
  return "";
}

/** List all managed sessions */
export function listManagedSessions(): string[] {
  if (hasTmux) {
    try {
      const raw = execSync("tmux list-sessions -F '#{session_name}'", {
        encoding: "utf-8",
        timeout: 5_000,
      });
      return raw.trim().split("\n").filter((s) => s.startsWith(SESSION_PREFIX + "-"));
    } catch {
      return [];
    }
  } else {
    const dir = runDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(SESSION_PREFIX + "-") && f.endsWith(".pid"))
      .map((f) => f.replace(".pid", ""));
  }
}

/** Get the attach command for a session (for dashboard display) */
export function attachCommand(name: string): string {
  if (hasTmux) {
    return `tmux attach -t ${name}`;
  }
  return `tail -f server/data/logs/${name}.log`;
}
