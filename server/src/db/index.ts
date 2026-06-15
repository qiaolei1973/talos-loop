import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { loadConfig } from "../config.js";
import type { IssueState } from "../types/plugin.js";

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
  // Check for old schema and handle clean break
  const hasOldSchema = db.prepare("PRAGMA table_info(issues)").all()
    .some((col: any) => col.name === "repo");

  if (hasOldSchema) {
    // Clean break: drop old table and recreate
    db.exec("DROP TABLE IF EXISTS sessions");
    db.exec("DROP TABLE IF EXISTS issues");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_repo TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      tmux_session TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_type, source_id)
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

    CREATE INDEX IF NOT EXISTS idx_issues_target_repo ON issues(target_repo);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);
  `);
}

// --- Issue Types ---

export interface Issue {
  id: number;
  source_type: string;
  source_id: string;
  target_repo: string;
  url: string;
  title: string | null;
  tmux_session: string | null;
  status: IssueState;
  created_at: string;
  updated_at: string;
}

// --- Issue CRUD ---

export function upsertIssue(
  sourceType: string,
  sourceId: string,
  targetRepo: string,
  url: string,
  title?: string | null,
): Issue {
  const d = getDb();
  d.prepare(
    `INSERT INTO issues (source_type, source_id, target_repo, url, title)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_type, source_id) DO UPDATE SET
       target_repo = excluded.target_repo,
       url = excluded.url,
       title = excluded.title,
       updated_at = datetime('now')`
  ).run(sourceType, sourceId, targetRepo, url, title ?? null);
  return d.prepare("SELECT * FROM issues WHERE source_type = ? AND source_id = ?")
    .get(sourceType, sourceId) as Issue;
}

export function getIssue(sourceType: string, sourceId: string): Issue | undefined {
  return getDb().prepare("SELECT * FROM issues WHERE source_type = ? AND source_id = ?")
    .get(sourceType, sourceId) as Issue | undefined;
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

export function updateIssueTmux(sourceType: string, sourceId: string, tmuxSession: string | null): void {
  getDb().prepare("UPDATE issues SET tmux_session = ?, updated_at = datetime('now') WHERE source_type = ? AND source_id = ?")
    .run(tmuxSession, sourceType, sourceId);
}

export function updateIssueStatus(sourceType: string, sourceId: string, status: IssueState): void {
  getDb().prepare("UPDATE issues SET status = ?, updated_at = datetime('now') WHERE source_type = ? AND source_id = ?")
    .run(status, sourceType, sourceId);
}

// --- Session Types ---

export interface Session {
  id: number;
  issue_id: number;
  tmux_session: string;
  status: "running" | "done" | "failed";
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
  status: "done" | "failed",
  prUrl?: string | null,
  error?: string | null,
): void {
  getDb().prepare("UPDATE sessions SET status = ?, pr_url = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, prUrl ?? null, error ?? null, sessionId);
}

/** Get running sessions joined with their issue info */
export function getRunningSessionsWithIssues(): (Session & { source_type: string; source_id: string; target_repo: string })[] {
  return getDb().prepare(`
    SELECT s.*, i.source_type, i.source_id, i.target_repo
    FROM sessions s
    JOIN issues i ON s.issue_id = i.id
    WHERE s.status = 'running'
  `).all() as (Session & { source_type: string; source_id: string; target_repo: string })[];
}
