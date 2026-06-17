import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { exitCodePath, readExitCode, sessionIdPath, readSessionId, sessionName } from "../tmux.js";

describe("sessionName sanitization (issue #7)", () => {
  it("passes through already-safe identifiers unchanged", () => {
    expect(sessionName("dima", "oceanbaseconsole-site", "123")).toBe(
      "tl-dima-oceanbaseconsole-site-123",
    );
  });

  it("replaces spaces in a display alias (e.g. 'GitHub Issues')", () => {
    expect(sessionName("GitHub Issues", "repo", "456")).toBe(
      "tl-GitHub_Issues-repo-456",
    );
  });

  it("neutralizes scoped package names so path.join sees no separators", () => {
    // The raw sourceType "@acme/jira" contains '@' and '/' — both would be
    // interpreted by path.join when building temp-file paths. They must be
    // flattened to a single flat segment.
    const name = sessionName("@acme/jira", "repo", "789");
    expect(name).toBe("tl-_acme_jira-repo-789");
    expect(name).not.toMatch("/");
    expect(name).not.toMatch("@");
  });

  it("produces a flat identifier safe for use as a filename segment", () => {
    const name = sessionName("@alipay/talos-plugin-dima", "oceanbase/console-site", "1.2");
    expect(name).not.toMatch(/[/@.]/);
  });
});

describe("readExitCode sentinel (issue #20)", () => {
  // A clearly test-only session name so the sentinel can't collide with a real
  // `tl-<source>-<repo>-<id>` session managed elsewhere.
  const session = "tl-readExitCode-test-only";

  function writeSentinel(content: string): void {
    fs.writeFileSync(exitCodePath(session), content, "utf-8");
  }

  it("returns the integer code and deletes the sentinel after reading", () => {
    writeSentinel("0\n");
    expect(readExitCode(session)).toBe(0);
    // single-use: the file is gone after the read
    expect(fs.existsSync(exitCodePath(session))).toBe(false);
  });

  it("returns a non-zero exit code verbatim", () => {
    writeSentinel("137");
    expect(readExitCode(session)).toBe(137);
    expect(fs.existsSync(exitCodePath(session))).toBe(false);
  });

  it("returns undefined when the sentinel is absent (unclean termination)", () => {
    // Ensure no leftover from a prior test, then read a missing sentinel.
    try {
      fs.unlinkSync(exitCodePath(session));
    } catch {
      // already absent
    }
    expect(readExitCode(session)).toBeUndefined();
  });

  it("returns undefined for non-integer sentinel contents", () => {
    writeSentinel("not-a-number");
    expect(readExitCode(session)).toBeUndefined();
    // the corrupt sentinel is still cleaned up
    expect(fs.existsSync(exitCodePath(session))).toBe(false);
  });
});

describe("readSessionId sidecar (issue #30)", () => {
  // A clearly test-only session name so the sidecar can't collide with a real one.
  const session = "tl-readSessionId-test-only";

  function writeSidecar(content: string): void {
    fs.writeFileSync(sessionIdPath(session), content, "utf-8");
  }

  it("returns the id and deletes the sidecar after reading", () => {
    writeSidecar("claude-uuid-123\n");
    expect(readSessionId(session)).toBe("claude-uuid-123");
    // single-use: the file is gone after the read
    expect(fs.existsSync(sessionIdPath(session))).toBe(false);
  });

  it("returns undefined when the sidecar is absent (init not seen yet)", () => {
    try {
      fs.unlinkSync(sessionIdPath(session));
    } catch {
      // already absent
    }
    expect(readSessionId(session)).toBeUndefined();
  });

  it("returns undefined for a blank sidecar (and still cleans it up)", () => {
    writeSidecar("   \n");
    expect(readSessionId(session)).toBeUndefined();
    expect(fs.existsSync(sessionIdPath(session))).toBe(false);
  });

  it("sessionIdPath lives in the tmp dir with the session-id prefix", () => {
    // Stable contract shared with the launcher's TL_SESSION_FILE env.
    expect(sessionIdPath(session)).toMatch(/\/tl-session-tl-readSessionId-test-only\.txt$/);
  });
});
