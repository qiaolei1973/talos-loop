import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point config at a throwaway DB BEFORE the db module reads it. loadConfig runs at
// the first getDb() call (inside the test below), after this top-level env write.
// Each test file runs in an isolated worker, so this won't bleed into the
// mocked-db test files (api/dispatcher).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-realdb-"));
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ dbPath: path.join(tmpDir, "test.db") }));

let db: typeof import("../db/index.js");
beforeAll(async () => {
  db = await import("../db/index.js");
});

describe("sessions.claude_session_id migration + round-trip (issue #30, seam B③)", () => {
  it("migrates the column in and round-trips setSessionClaudeId", () => {
    const database = db.getDb();
    const cols = database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    // Additive migration landed the column on a fresh DB.
    expect(cols.some((c) => c.name === "claude_session_id")).toBe(true);

    const issue = db.upsertIssue("qiaolei1973/1", "github", "30", "talos-loop", "https://example/issues/30", "PRD");
    const session = db.createSession(issue.id, "tl-realdb-session");

    // Before the dispatcher captures an id: null.
    expect(db.getSessionsByIssue(issue.id)[0].claude_session_id).toBeNull();

    // The dispatcher writes the captured id once the formatter's sidecar appears.
    db.setSessionClaudeId(session.id, "claude-uuid-30");
    expect(db.getSessionsByIssue(issue.id)[0].claude_session_id).toBe("claude-uuid-30");
  });
});

describe("sessions.retry_count migration + round-trip (issue #32)", () => {
  it("adds retry_count, drops pr_url, and round-trips createSession's retryCount", () => {
    const database = db.getDb();
    const cols = database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);

    // issue #32: retry_count is new…
    expect(names).toContain("retry_count");
    // …and pr_url is gone (the server no longer tracks PRs).
    expect(names).not.toContain("pr_url");

    const issue = db.upsertIssue("qiaolei1973/1", "github", "32", "talos-loop", "https://example/issues/32", "PRD");

    // A fresh coding session starts at retry 0.
    db.createSession(issue.id, "tl-session-0");
    expect(db.getSessionsByIssue(issue.id)[0].retry_count).toBe(0);

    // A `claude -r` retry session records the incremented retry chain up front.
    db.createSession(issue.id, "tl-session-1", { type: "coding", retryCount: 1 });
    const sessions = db.getSessionsByIssue(issue.id);
    expect(sessions.find((s) => s.tmux_session === "tl-session-1")!.retry_count).toBe(1);
  });
});
