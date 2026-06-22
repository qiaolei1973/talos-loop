import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { loadConfig } from "../config.js";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const config = loadConfig();
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database) {
  // Clean break on legacy schemas. issue #32 reshapes the sessions table (drops
  // pr_url — the server no longer tracks PRs — and adds retry_count for the
  // auto claude -r retry). Any sessions table still carrying `pr_url`, or
  // predating the GitHub Projects schema from #9, is dropped & recreated. This
  // is an internal system; a data reset is acceptable (prior issues mandate the
  // same clean break).
  const cols = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  const hasCol = (name: string) => cols.some((c) => c.name === name);
  const issuesLegacy =
    cols.length > 0 &&
    (hasCol("status") || hasCol("tmux_session") || (hasCol("source_type") && !hasCol("project_id")));

  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasSessionCol = (name: string) => sessionCols.some((c) => c.name === name);
  // issue #32: pr_url is gone; retry_count is new. Either signature ⇒ rebuild.
  const sessionsLegacy = sessionCols.length > 0 && (hasSessionCol("pr_url") || !hasSessionCol("retry_count"));

  if (issuesLegacy || sessionsLegacy) {
    db.exec("DROP TABLE IF EXISTS sessions");
    db.exec("DROP TABLE IF EXISTS issues");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      project_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_repo TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      tmux_session TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      -- 'coding' (default, implements the issue) or 'review' (fixes review
      -- threads on an existing PR). Drives how checkRunningSessions classifies
      -- the session: review sessions never advance the board.
      type TEXT NOT NULL DEFAULT 'coding',
      -- The PR head branch the agent pushes to (coding cuts it; review checks
      -- it out to push fixes to the existing PR).
      branch TEXT,
      -- The server-determined worktree path. Written at dispatch so the path is
      -- known without the agent reporting back; a retry/claude -r session
      -- inherits it to reuse the worktree.
      worktree_path TEXT,
      -- The captured Claude Code session id, for "claude -r" resume/inspect.
      -- Written mid-run by the dispatcher (from the stream-formatter sidecar),
      -- so it survives a crash and is available for retry.
      claude_session_id TEXT,
      -- issue #32: how many claude -r retries have run for this issue's chain.
      -- The server auto-retries a crashed coding session up to maxRetry times.
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_target_repo ON issues(target_repo);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      plugin TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// --- Issue Types ---

/**
 * An issue's identity + display cache ONLY. There is no `status` or
 * `tmux_session` column: workflow status is DERIVED from the in-memory board
 * snapshot (standard state, single writer = `writeLabel()`) plus the sessions
 * table (running-state truth). See services/displayState.ts.
 */
export interface Issue {
  id: number;
  project_id: string;
  project_type: string;
  source_id: string;
  target_repo: string;
  url: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

// --- Issue CRUD ---

export function upsertIssue(
  projectId: string,
  projectType: string,
  sourceId: string,
  targetRepo: string,
  url: string,
  title?: string | null,
): Issue {
  const d = getDb();
  d.prepare(
    `INSERT INTO issues (project_id, project_type, source_id, target_repo, url, title)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, source_id) DO UPDATE SET
       project_type = excluded.project_type,
       target_repo = excluded.target_repo,
       url = excluded.url,
       title = excluded.title,
       updated_at = datetime('now')`
  ).run(projectId, projectType, sourceId, targetRepo, url, title ?? null);
  return d.prepare("SELECT * FROM issues WHERE project_id = ? AND source_id = ?")
    .get(projectId, sourceId) as Issue;
}

export function getIssue(projectId: string, sourceId: string): Issue | undefined {
  return getDb().prepare("SELECT * FROM issues WHERE project_id = ? AND source_id = ?")
    .get(projectId, sourceId) as Issue | undefined;
}

export function getIssueById(id: number): Issue | undefined {
  return getDb().prepare("SELECT * FROM issues WHERE id = ?").get(id) as Issue | undefined;
}

export function getIssuesByTargetRepo(targetRepo: string): Issue[] {
  return getDb().prepare("SELECT * FROM issues WHERE target_repo = ? ORDER BY updated_at DESC")
    .all(targetRepo) as Issue[];
}

export function getAllIssues(): Issue[] {
  return getDb().prepare("SELECT * FROM issues ORDER BY updated_at DESC").all() as Issue[];
}

// --- Session Types ---

export interface Session {
  id: number;
  issue_id: number;
  tmux_session: string;
  /**
   * running → done | failed | killed. There is no `skipped` state (issue #32
   * removed the skip action). `killed` marks a session torn down by the
   * dashboard's kill action — terminal like failed, but distinct so the UI can
   * show "killed"; a killed coding session is still retryable from its
   * preserved worktree.
   */
  status: "running" | "done" | "failed" | "killed";
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** 'coding' (default) or 'review' (fixes review threads). */
  type: "coding" | "review";
  /** PR head branch — set at dispatch (coding cuts it; review reuses it). */
  branch: string | null;
  /** Server-determined worktree path; inherited by a retry session. */
  worktree_path: string | null;
  /** Captured Claude Code session id (for `claude -r` resume). */
  claude_session_id: string | null;
  /** How many claude -r retries have run in this issue's session chain. */
  retry_count: number;
}

// --- Session CRUD ---

/**
 * Record the captured Claude Code session id on a session row. Called by
 * checkRunningSessions each cycle once the stream formatter has written the id
 * to its sidecar (at the stream's init event) — so the id lands in the DB
 * mid-run, survives a crash, and is available for `claude -r` retry.
 */
export function setSessionClaudeId(sessionId: number, claudeSessionId: string): void {
  getDb().prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?")
    .run(claudeSessionId, sessionId);
}

/**
 * Create a session row. Coding sessions (the default) carry their
 * server-determined `worktreePath` + `branch`; review sessions pass `type:
 * "review"` and reuse the issue's feat branch. A `claude -r` retry passes the
 * prior `retryCount` so the new row records the incremented retry chain.
 */
export function createSession(
  issueId: number,
  tmuxSession: string,
  init?: { type?: "coding" | "review"; branch?: string; worktreePath?: string; retryCount?: number },
): Session {
  const d = getDb();
  const type = init?.type ?? "coding";
  d.prepare(
    `INSERT INTO sessions (issue_id, tmux_session, type, branch, worktree_path, retry_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(issueId, tmuxSession, type, init?.branch ?? null, init?.worktreePath ?? null, init?.retryCount ?? 0);
  return d.prepare("SELECT * FROM sessions WHERE id = last_insert_rowid()").get() as Session;
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'running'").all() as Session[];
}

export function getSessionsByIssue(issueId: number): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at DESC")
    .all(issueId) as Session[];
}

/** Look up a single session by its DB id (kill endpoint). */
export function getSessionById(id: number): Session | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
}

export function updateSessionStatus(
  sessionId: number,
  status: "done" | "failed" | "killed",
  error?: string | null,
): void {
  getDb().prepare("UPDATE sessions SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, error ?? null, sessionId);
}

/**
 * The latest session for an issue (retry classification + retry-target lookup).
 * Ordered by id DESC. Used by checkRunningSessions to decide whether a crashed
 * coding session can still auto-retry (it needs a claude_session_id to resume).
 */
export function getLatestSession(issueId: number): (Session & {
  project_id: string;
  project_type: string;
  source_id: string;
  target_repo: string;
  url: string;
}) | undefined {
  return getDb().prepare(`
    SELECT s.*, i.project_id, i.project_type, i.source_id, i.target_repo, i.url
    FROM sessions s
    JOIN issues i ON s.issue_id = i.id
    WHERE s.issue_id = ?
    ORDER BY s.id DESC
    LIMIT 1
  `).get(issueId) as (Session & {
    project_id: string;
    project_type: string;
    source_id: string;
    target_repo: string;
    url: string;
  }) | undefined;
}

/** Get running sessions joined with their issue info */
export function getRunningSessionsWithIssues(): (Session & { project_id: string; project_type: string; source_id: string; target_repo: string })[] {
  return getDb().prepare(`
    SELECT s.*, i.project_id, i.project_type, i.source_id, i.target_repo
    FROM sessions s
    JOIN issues i ON s.issue_id = i.id
    WHERE s.status = 'running'
  `).all() as (Session & { project_id: string; project_type: string; source_id: string; target_repo: string })[];
}

/**
 * Issue ids that currently have a running review session. `dispatchReview()`
 * skips these: only one review session per issue at a time, reusing the
 * serial-dispatch guarantee to prevent concurrent agents on the same PR branch.
 */
export function getRunningReviewIssueIds(): Set<number> {
  const rows = getDb().prepare(
    "SELECT DISTINCT issue_id FROM sessions WHERE type = 'review' AND status = 'running'",
  ).all() as Array<{ issue_id: number }>;
  return new Set(rows.map((r) => r.issue_id));
}

// --- Settings Types ---

export interface Setting {
  key: string;
  value: string;
  plugin: string;
  updated_at: string;
}

// --- Settings CRUD ---

export function getAllSettings(): Setting[] {
  return getDb().prepare("SELECT * FROM settings ORDER BY plugin, key").all() as Setting[];
}

export function getSettingsByPlugin(plugin: string): Setting[] {
  return getDb().prepare("SELECT * FROM settings WHERE plugin = ? ORDER BY key").all(plugin) as Setting[];
}

export function upsertSetting(key: string, value: string, plugin: string): Setting {
  const d = getDb();
  d.prepare(
    `INSERT INTO settings (key, value, plugin) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value, plugin);
  return d.prepare("SELECT * FROM settings WHERE key = ?").get(key) as Setting;
}

export function deleteSetting(key: string): boolean {
  const d = getDb();
  const info = d.prepare("DELETE FROM settings WHERE key = ?").run(key);
  return info.changes > 0;
}
