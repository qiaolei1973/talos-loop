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
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      tmux_session TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, number)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      tmux_session TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      pr_url TEXT,
      log_path TEXT,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);
  `);
}

// --- Issue CRUD ---

export interface Issue {
  id: number;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  tmux_session: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertIssue(repo: string, number: number, url: string, title?: string): Issue {
  const d = getDb();
  d.prepare(
    `INSERT INTO issues (repo, number, url, title) VALUES (?, ?, ?, ?)
     ON CONFLICT(repo, number) DO UPDATE SET url = excluded.url, title = excluded.title, updated_at = datetime('now')`
  ).run(repo, number, url, title ?? null);
  return d.prepare("SELECT * FROM issues WHERE repo = ? AND number = ?").get(repo, number) as Issue;
}

export function getIssue(repo: string, number: number): Issue | undefined {
  return getDb().prepare("SELECT * FROM issues WHERE repo = ? AND number = ?").get(repo, number) as Issue | undefined;
}

export function getIssuesByRepo(repo: string): Issue[] {
  return getDb().prepare("SELECT * FROM issues WHERE repo = ? ORDER BY number DESC").all(repo) as Issue[];
}

export function getAllIssues(): Issue[] {
  return getDb().prepare("SELECT * FROM issues ORDER BY updated_at DESC").all() as Issue[];
}

export function updateIssueTmux(repo: string, number: number, tmuxSession: string | null): void {
  getDb().prepare("UPDATE issues SET tmux_session = ?, updated_at = datetime('now') WHERE repo = ? AND number = ?")
    .run(tmuxSession, repo, number);
}

// --- Session CRUD ---

export interface Session {
  id: number;
  issue_id: number;
  tmux_session: string;
  status: "running" | "done" | "failed";
  pr_url: string | null;
  log_path: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function createSession(issueId: number, tmuxSession: string, logPath: string): Session {
  const d = getDb();
  d.prepare("INSERT INTO sessions (issue_id, tmux_session, log_path) VALUES (?, ?, ?)")
    .run(issueId, tmuxSession, logPath);
  return d.prepare("SELECT * FROM sessions WHERE id = last_insert_rowid()").get() as Session;
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'running'").all() as Session[];
}

export function getSessionsByIssue(issueId: number): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at DESC").all(issueId) as Session[];
}

export function updateSessionStatus(
  sessionId: number,
  status: "done" | "failed",
  prUrl?: string,
  error?: string
): void {
  getDb().prepare("UPDATE sessions SET status = ?, pr_url = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, prUrl ?? null, error ?? null, sessionId);
}
