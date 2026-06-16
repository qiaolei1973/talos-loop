import { describe, it, expect } from "vitest";
import { sessionName } from "../tmux.js";

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
