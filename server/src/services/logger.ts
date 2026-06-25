import { promises as fsp } from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".talos", "logs");
const LOG_FILE = path.join(LOG_DIR, "talos-loop.log");

// Ensure log directory exists (one-time sync at module load — not on the hot path)
import fs from "fs";
fs.mkdirSync(LOG_DIR, { recursive: true });

type Level = "INFO" | "WARN" | "ERROR";

function timestamp(): string {
  const iso = new Date().toISOString();
  return iso.replace("T", " ").replace("Z", "");
}

// Async write queue: batch log lines per event-loop tick so a burst of
// synchronous log calls produces a single appendFile, keeping the Logger
// interface synchronous while the actual file I/O is non-blocking.
let writeQueue: string[] = [];
let flushPending = false;

async function flushQueue(): Promise<void> {
  if (writeQueue.length === 0) return;
  const batch = writeQueue.join("");
  writeQueue = [];
  flushPending = false;
  try {
    await fsp.appendFile(LOG_FILE, batch, "utf-8");
  } catch {
    // Silently ignore file write errors
  }
}

function scheduleFlush(): void {
  if (!flushPending) {
    flushPending = true;
    setImmediate(() => {
      flushQueue().catch(() => {});
    });
  }
}

function write(level: Level, module: string, ...args: unknown[]): void {
  const msg = args.map(String).join(" ");
  const line = `[${timestamp()}] [${level}] [${module}] ${msg}`;

  // Console output (color-coded)
  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }

  // File output — queued, async, non-blocking
  try {
    writeQueue.push(line + "\n");
    scheduleFlush();
  } catch {
    // Silently ignore
  }
}

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(module: string): Logger {
  return {
    info: (...args: unknown[]) => write("INFO", module, ...args),
    warn: (...args: unknown[]) => write("WARN", module, ...args),
    error: (...args: unknown[]) => write("ERROR", module, ...args),
  };
}
