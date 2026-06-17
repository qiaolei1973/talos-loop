import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Logger } from "./services/logger.js";
import type { ProjectContext, RepoRef } from "./types/plugin.js";

/**
 * A single GitHub Project (or future project-management system) that talos-loop
 * serves. Replaces the old pair (repos.json + config.sources[]): each project is
 * self-contained, carrying its own repos and an optional plugin-config block.
 */
export interface ProjectConfig {
  /** "owner/number", e.g. "qiaolei1973/1". Human-readable; parsed by the plugin. */
  projectId: string;
  /** Plugin type: "github" (built-in) or an external plugin package name / path. */
  projectType: string;
  enabled: boolean;
  /** Repos declared for this project. `name` is the path basename (doubles as target_repo key). */
  repos: RepoRef[];
  /** Optional plugin-specific overrides. */
  config?: Record<string, unknown>;
}

export interface AppConfig {
  port: number;
  pollInterval: number;  // ms
  maxParallel: number;
  claudeTimeout: number; // seconds
  dbPath: string;
  /** Base URL the running agent uses to reach talos-loop's local API (skip/comment endpoints). */
  serverBaseUrl: string;
  /** GraphQL remaining capacity below which the poller skips a board read, so talos-loop doesn't collide with the dispatched agent over the shared 5000/h token budget. */
  quotaThreshold: number;
  /**
   * dispatchReview() fires every Nth dispatch cycle (issue #19), giving a
   * reviewer time to batch several rounds of "Request changes" comments before
   * the review-fix agent runs. Default 15 ≈ 15 min at the 60s poll interval.
   */
  reviewDispatchEvery: number;
  /**
   * issue #26: when false (default), checkRunningSessions tears down a
   * successfully-completed (exit-0) session's tmux window via killSession() so
   * completed sessions don't accumulate in `tmux ls`. Set true to opt back into
   * the keep-alive behavior (leave the window open for inspection). Failed
   * sessions are ALWAYS kept alive regardless, so their output stays available.
   */
  keepSessionOnSuccess: boolean;
}

const PROJECT_ROOT = path.resolve(__dirname, "../..");

/** Resolved at call time (not module load) so tests can override via CONFIG_PATH. */
function configPath(): string {
  return process.env.CONFIG_PATH || path.join(PROJECT_ROOT, "config.json");
}

/** Resolved at call time (not module load) so tests can override via PROJECTS_PATH. */
function projectsPath(): string {
  return process.env.PROJECTS_PATH || path.join(PROJECT_ROOT, "projects.json");
}

let cachedConfig: AppConfig | null = null;
let cachedProjects: ProjectConfig[] | null = null;

function defaults(): Partial<AppConfig> {
  return {
    port: 3100,
    pollInterval: 60_000, // 1 minute
    maxParallel: 1,
    claudeTimeout: 600,
    dbPath: path.join(PROJECT_ROOT, "server/data/talos-loop.db"),
    // Leave headroom for the dispatched agent (shares this token). A board read
    // is ~1 item-list; 200 survives a full poll plus concurrent agent traffic.
    quotaThreshold: 200,
    reviewDispatchEvery: 15,
    keepSessionOnSuccess: false,
  };
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const raw = fs.readFileSync(configPath(), "utf-8");
  const parsed = JSON.parse(raw);
  const def = defaults();

  const port = parsed.port ?? def.port!;
  cachedConfig = {
    port,
    pollInterval: parsed.pollInterval ?? def.pollInterval!,
    maxParallel: parsed.maxParallel ?? def.maxParallel!,
    claudeTimeout: parsed.claudeTimeout ?? def.claudeTimeout!,
    dbPath: parsed.dbPath ?? def.dbPath!,
    serverBaseUrl: parsed.serverBaseUrl ?? `http://127.0.0.1:${port}`,
    quotaThreshold: parsed.quotaThreshold ?? def.quotaThreshold!,
    reviewDispatchEvery: parsed.reviewDispatchEvery ?? def.reviewDispatchEvery!,
    keepSessionOnSuccess: parsed.keepSessionOnSuccess ?? def.keepSessionOnSuccess!,
  };

  // Ensure database directory exists
  fs.mkdirSync(path.dirname(cachedConfig.dbPath), { recursive: true });

  return cachedConfig;
}

/** Reload config and projects caches (test helper). Drops cached state so the next read re-reads from disk. */
export function resetConfigCache(): void {
  cachedConfig = null;
  cachedProjects = null;
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
 * Load projects from projects.json. Each entry is
 * `{ projectId, projectType, enabled?, repos: [{path, remote?}], config? }`.
 * `repos[].name` is the path basename; `remote` is the override or git-inferred
 * "owner/repo". Missing file → empty array. Duplicate repo basenames within a
 * project emit a console warning (they collide on the target_repo key).
 */
export function loadProjects(): ProjectConfig[] {
  if (cachedProjects) return cachedProjects;

  if (!fs.existsSync(projectsPath())) {
    cachedProjects = [];
    return cachedProjects;
  }

  const raw = fs.readFileSync(projectsPath(), "utf-8");
  const parsed = JSON.parse(raw) as Array<{
    projectId: string;
    projectType: string;
    enabled?: boolean;
    repos?: Array<{ path: string; remote?: string }>;
    config?: Record<string, unknown>;
  }>;

  cachedProjects = parsed.map((p) => {
    const repos: RepoRef[] = (p.repos ?? []).map((r) => ({
      name: basename(r.path),
      path: r.path,
      remote: r.remote ?? inferRemote(r.path),
    }));

    // Duplicate basenames within a project collide on the target_repo key.
    const seen = new Set<string>();
    for (const r of repos) {
      if (seen.has(r.name)) console.warn(`[config] project "${p.projectId}" has duplicate repo basename "${r.name}"`);
      seen.add(r.name);
    }

    return {
      projectId: p.projectId,
      projectType: p.projectType,
      enabled: p.enabled ?? true,
      repos,
      config: p.config,
    };
  });

  return cachedProjects;
}

export function getEnabledProjects(): ProjectConfig[] {
  return loadProjects().filter((p) => p.enabled && p.repos.length > 0);
}

export function getProjectById(projectId: string): ProjectConfig | undefined {
  return loadProjects().find((p) => p.projectId === projectId);
}

/** Build ProjectContext for a project, exposing all its repos. */
export function buildProjectContext(project: ProjectConfig, logger: Logger): ProjectContext {
  return {
    config: project.config ?? {},
    logger,
    repos: project.repos,
    projectId: project.projectId,
  };
}

/** Build ProjectContext by projectId (looks up the project; throws if unknown). */
export function buildProjectContextForIssue(projectId: string, logger: Logger): ProjectContext {
  const project = getProjectById(projectId);
  if (!project) throw new Error(`Unknown projectId "${projectId}" — not declared in projects.json`);
  return buildProjectContext(project, logger);
}
