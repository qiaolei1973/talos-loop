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
