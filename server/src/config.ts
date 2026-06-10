import fs from "fs";
import path from "path";

export interface RepoConfig {
  name: string;
  github: string; // "owner/repo"
  path: string; // local repo path for claude -p working directory
  enabled: boolean;
}

export interface AppConfig {
  port: number;
  pollInterval: number; // ms
  triggerLabel: string;
  processingLabel: string;
  doneLabel: string;
  failedLabel: string;
  maxParallel: number;
  claudeTimeout: number; // seconds
  repos: RepoConfig[];
  dbPath: string;
  logDir: string;
}

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(PROJECT_ROOT, "config.json");

let cachedConfig: AppConfig | null = null;

function defaults(): Partial<AppConfig> {
  return {
    port: 3100,
    pollInterval: 60_000, // 1 minute
    triggerLabel: "ready-for-agent",
    processingLabel: "agent-processing",
    doneLabel: "agent-done",
    failedLabel: "agent-failed",
    maxParallel: 1,
    claudeTimeout: 600,
    dbPath: path.join(PROJECT_ROOT, "server/data/talos-loop.db"),
    logDir: path.join(PROJECT_ROOT, "server/data/logs"),
  };
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const def = defaults();

  cachedConfig = {
    port: parsed.port ?? def.port!,
    pollInterval: parsed.pollInterval ?? def.pollInterval!,
    triggerLabel: parsed.triggerLabel ?? def.triggerLabel!,
    processingLabel: parsed.processingLabel ?? def.processingLabel!,
    doneLabel: parsed.doneLabel ?? def.doneLabel!,
    failedLabel: parsed.failedLabel ?? def.failedLabel!,
    maxParallel: parsed.maxParallel ?? def.maxParallel!,
    claudeTimeout: parsed.claudeTimeout ?? def.claudeTimeout!,
    dbPath: parsed.dbPath ?? def.dbPath!,
    logDir: parsed.logDir ?? def.logDir!,
    repos: (parsed.repos ?? []).map((r: RepoConfig) => ({
      name: r.name,
      github: r.github,
      path: r.path,
      enabled: r.enabled ?? true,
    })),
  };

  // Ensure data directories exist
  fs.mkdirSync(path.dirname(cachedConfig.dbPath), { recursive: true });
  fs.mkdirSync(cachedConfig.logDir, { recursive: true });

  return cachedConfig;
}

export function getEnabledRepos(): RepoConfig[] {
  return loadConfig().repos.filter((r) => r.enabled);
}
