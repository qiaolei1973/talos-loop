import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".talos", "logs");
const LOG_FILE = path.join(LOG_DIR, "talos-loop.log");

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

type Level = "INFO" | "WARN" | "ERROR";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
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

  // File output
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // Silently ignore file write errors
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
