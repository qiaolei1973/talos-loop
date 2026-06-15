import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Logger } from "./services/logger.js";
import type { SourceContext, RepoRef } from "./types/plugin.js";

/** Code repository — where Claude runs. `remote` is "owner/repo" (optional: inferred from git remote, overridable). */
export interface RepoConfig {
  name: string;
  path: string;
  remote?: string;
}

/** Issue source — where issues come from. Bound to exactly one repo by name. */
export interface SourceConfig {
  type: string;            // "github", or an external plugin package name/path
  enabled: boolean;
  repo: string;            // basename of a path declared in repos.json
  config?: Record<string, unknown>;  // optional plugin-specific overrides (e.g. label names)
}

export interface AppConfig {
  port: number;
  pollInterval: number;  // ms
  maxParallel: number;
  claudeTimeout: number; // seconds
  dbPath: string;
  sources: SourceConfig[];
}

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(PROJECT_ROOT, "config.json");
const REPOS_PATH = process.env.REPOS_PATH || path.join(PROJECT_ROOT, "repos.json");

let cachedConfig: AppConfig | null = null;
let cachedRepos: RepoConfig[] | null = null;

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
    sources: (parsed.sources ?? []).map((s: any) => ({
      type: s.type,
      enabled: s.enabled ?? true,
      repo: s.repo,
      config: s.config ?? {},
    })),
  };

  // Ensure database directory exists
  fs.mkdirSync(path.dirname(cachedConfig.dbPath), { recursive: true });

  return cachedConfig;
}

/** Reload config and repos caches (test helper). Drops the cached state so the next read re-reads from disk. */
export function resetConfigCache(): void {
  cachedConfig = null;
  cachedRepos = null;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

/** Parse a git remote URL (SSH or HTTPS) into "owner/repo". */
function parseOwnerRepo(url: string): string | undefined {
  const m = url.match(/([^/:\s]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Infer "owner/repo" from `git remote get-url origin` in the given path. */
function inferRemote(repoPath: string): string | undefined {
  try {
    const url = execSync(`git -C ${repoPath} remote get-url origin`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
    }).trim();
    return parseOwnerRepo(url);
  } catch {
    return undefined;
  }
}

/**
 * Load repos from repos.json. Each entry is `{ path, remote? }`; `name` is the
 * path basename and `remote` is the given override or git-inferred "owner/repo".
 * Missing file → empty array.
 */
export function loadRepos(): RepoConfig[] {
  if (cachedRepos) return cachedRepos;

  if (!fs.existsSync(REPOS_PATH)) {
    cachedRepos = [];
    return cachedRepos;
  }

  const raw = fs.readFileSync(REPOS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Array<{ path: string; remote?: string }>;

  cachedRepos = parsed.map((r) => ({
    name: basename(r.path),
    path: r.path,
    remote: r.remote ?? inferRemote(r.path),
  }));

  return cachedRepos;
}

export function getRepoByName(name: string): RepoConfig | undefined {
  return loadRepos().find((r) => r.name === name);
}

export function getRepos(): RepoConfig[] {
  return loadRepos();
}

/** Find the source bound to a repo (by `source.repo`). */
export function getSourceByRepo(repoName: string): SourceConfig | undefined {
  return loadConfig().sources.find((s) => s.repo === repoName);
}

/**
 * Enabled sources whose `repo` resolves to a declared repo. Sources with a
 * missing or unresolvable `repo` are filtered out (the caller should warn).
 */
export function getEnabledSources(): SourceConfig[] {
  const repos = loadRepos();
  return loadConfig().sources.filter((s) => s.enabled && repos.some((r) => r.name === s.repo));
}

/** Build SourceContext for a source, injecting its resolved repo. */
export function buildSourceContext(source: SourceConfig, logger: Logger): SourceContext {
  return {
    config: source.config ?? {},
    logger,
    repo: repoToRef(getRepoByName(source.repo)),
  };
}

/** Build SourceContext from a repo name (used when only the repo — not the source — is known, e.g. dispatch by issue). */
export function buildSourceContextForRepo(repoName: string, logger: Logger): SourceContext {
  const source = getSourceByRepo(repoName);
  return {
    config: source?.config ?? {},
    logger,
    repo: repoToRef(getRepoByName(repoName)),
  };
}

function repoToRef(repo: RepoConfig | undefined): RepoRef | undefined {
  if (!repo) return undefined;
  return { name: repo.name, path: repo.path, remote: repo.remote };
}
