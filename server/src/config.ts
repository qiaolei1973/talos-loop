import fs from "fs";
import path from "path";

/** Code repository — where Claude runs */
export interface RepoConfig {
  name: string;
  remote: string; // e.g. "qiaolei1973/talos-deploy" or full URL
  path: string;   // local filesystem path
}

/** Issue source — where issues come from */
export interface SourceConfig {
  type: string;                      // "github", "dima", etc.
  enabled: boolean;
  config: Record<string, unknown>;   // plugin-specific config
}

export interface AppConfig {
  port: number;
  pollInterval: number;  // ms
  maxParallel: number;
  claudeTimeout: number; // seconds
  dbPath: string;
  repos: RepoConfig[];
  sources: SourceConfig[];
}

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(PROJECT_ROOT, "config.json");

let cachedConfig: AppConfig | null = null;

function defaults(): Partial<AppConfig> {
  return {
    port: 3100,
    pollInterval: 60_000, // 1 minute
    maxParallel: 1,
    claudeTimeout: 600,
    dbPath: path.join(PROJECT_ROOT, "server/data/talos-loop.db"),
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
    maxParallel: parsed.maxParallel ?? def.maxParallel!,
    claudeTimeout: parsed.claudeTimeout ?? def.claudeTimeout!,
    dbPath: parsed.dbPath ?? def.dbPath!,
    repos: (parsed.repos ?? []).map((r: RepoConfig) => ({
      name: r.name,
      remote: r.remote,
      path: r.path,
    })),
    sources: (parsed.sources ?? []).map((s: SourceConfig) => ({
      type: s.type,
      enabled: s.enabled ?? true,
      config: s.config ?? {},
    })),
  };

  // Ensure database directory exists
  fs.mkdirSync(path.dirname(cachedConfig.dbPath), { recursive: true });

  return cachedConfig;
}

export function getEnabledSources(): SourceConfig[] {
  return loadConfig().sources.filter((s) => s.enabled);
}

export function getRepoByName(name: string): RepoConfig | undefined {
  return loadConfig().repos.find((r) => r.name === name);
}
