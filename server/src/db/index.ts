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
  // Clean break: drop & recreate if the issues table carries columns removed by
  // issue #13 (the persisted `status` / `tmux_session` workflow columns — now
  // derived) or predates the GitHub Projects schema from #9 (`source_type`
  // without `project_id`). This is an internal system; a data reset is
  // acceptable (issues #9 and #13 both mandate clean breaks).
  const cols = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  const hasCol = (name: string) => cols.some((c) => c.name === name);
  const legacy =
    cols.length > 0 &&
    (hasCol("status") || hasCol("tmux_session") || (hasCol("source_type") && !hasCol("project_id")));
  if (legacy) {
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
      pr_url TEXT,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_target_repo ON issues(target_repo);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);
  `);
}

// --- Issue Types ---

/**
 * An issue's identity + display cache ONLY. There is no `status` or
 * `tmux_session` column: workflow status is now DERIVED (issue #13) from the
 * GitHub Projects board (single writer = `transition()`) plus the sessions
 * table (running-state truth). Persisting a second copy here is what caused the
 * board/DB drift incidents this change eliminates. See services/displayState.ts.
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
  status: "running" | "done" | "failed" | "skipped";
  pr_url: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

// --- Session CRUD ---

export function createSession(issueId: number, tmuxSession: string): Session {
  const d = getDb();
  d.prepare("INSERT INTO sessions (issue_id, tmux_session) VALUES (?, ?)")
    .run(issueId, tmuxSession);
  return d.prepare("SELECT * FROM sessions WHERE id = last_insert_rowid()").get() as Session;
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'running'").all() as Session[];
}

export function getSessionsByIssue(issueId: number): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at DESC")
    .all(issueId) as Session[];
}

export function updateSessionStatus(
  sessionId: number,
  status: "done" | "failed" | "skipped",
  prUrl?: string | null,
  error?: string | null,
): void {
  getDb().prepare("UPDATE sessions SET status = ?, pr_url = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, prUrl ?? null, error ?? null, sessionId);
}

/**
 * Mark an issue's currently-running session as skipped and record the reason.
 * Called by the skip HTTP endpoint so checkRunningSessions does not subsequently
 * treat the (now-dead) session as a done/infrastructure-failure outcome — the
 * plugin has already moved the issue back to Ready and applied the skip marker.
 */
export function markSessionSkipped(issueId: number, reason: string): void {
  getDb().prepare(
    `UPDATE sessions SET status = 'skipped', error = ?, finished_at = datetime('now')
     WHERE issue_id = ? AND status = 'running'`
  ).run(reason, issueId);
}

/**
 * Record the PR URL on an issue's currently-running session. Called by the
 * submit-pr action handler so checkRunningSessions classifies the (eventually
 * dead) session as done from stored state — without parsing tmux output. The
 * session stays `running` until checkRunningSessions performs the done-flow
 * finalization, which is how double-processing is prevented.
 */
export function setSessionPrUrl(issueId: number, prUrl: string): void {
  getDb().prepare("UPDATE sessions SET pr_url = ? WHERE issue_id = ? AND status = 'running'")
    .run(prUrl, issueId);
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
