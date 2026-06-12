import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubIssueSourcePlugin } from "../index.js";
import type { SourceContext } from "../../../types/plugin.js";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Mock fs for onComment
vi.mock("fs", () => ({
  default: {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { execSync } from "child_process";

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

function makeCtx(configOverrides: Record<string, unknown> = {}): SourceContext {
  return {
    config: {
      repo: "test/repo",
      targetRepo: "test-repo",
      triggerLabel: "ready-for-agent",
      processingLabel: "agent-processing",
      doneLabel: "agent-done",
      failedLabel: "agent-failed",
      ...configOverrides,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("GitHubIssueSourcePlugin", () => {
  let plugin: GitHubIssueSourcePlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new GitHubIssueSourcePlugin();
  });

  describe("name", () => {
    it("should have name 'github'", () => {
      expect(plugin.name).toBe("github");
    });
  });

  describe("init()", () => {
    it("should create labels via gh CLI", async () => {
      mockExecSync.mockReturnValue("");
      const ctx = makeCtx();

      await plugin.init(ctx);

      // Should call gh label create for each of 4 labels
      const calls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh label create")
      );
      expect(calls.length).toBe(4);
    });
  });

  describe("test()", () => {
    it("should return true when gh auth succeeds", async () => {
      mockExecSync.mockReturnValue("");
      const ctx = makeCtx();

      const result = await plugin.test(ctx);
      expect(result).toBe(true);
    });

    it("should return false when gh auth fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not authenticated");
      });
      const ctx = makeCtx();

      const result = await plugin.test(ctx);
      expect(result).toBe(false);
    });
  });

  describe("discover()", () => {
    it("should parse gh issue list output and return RawIssue[]", async () => {
      const ctx = makeCtx();
      const ghResponse = JSON.stringify([
        {
          number: 42,
          title: "Test issue",
          url: "https://github.com/test/repo/issues/42",
          labels: [{ name: "ready-for-agent" }],
        },
      ]);

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) return ghResponse;
        return "[]";
      });

      const issues = await plugin.discover(ctx);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({
        sourceType: "github",
        sourceId: "42",
        url: "https://github.com/test/repo/issues/42",
        title: "Test issue",
        targetRepo: "test-repo",
        metadata: { labels: ["ready-for-agent"] },
      });
    });

    it("should return empty array when gh fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("gh CLI error");
      });
      const ctx = makeCtx();

      const issues = await plugin.discover(ctx);
      expect(issues).toEqual([]);
    });

    it("should deduplicate issues across trigger and processing labels", async () => {
      const ctx = makeCtx();
      const issue = {
        number: 1,
        title: "Dupe",
        url: "https://github.com/test/repo/issues/1",
        labels: [{ name: "ready-for-agent" }, { name: "agent-processing" }],
      };

      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        // First call = trigger label, second call = processing label
        return JSON.stringify([issue]);
      });

      const issues = await plugin.discover(ctx);
      // Should only return one issue (deduped by number)
      expect(issues).toHaveLength(1);
    });
  });

  describe("getStatus()", () => {
    it("should return labels from gh issue view", async () => {
      const ctx = makeCtx();
      mockExecSync.mockReturnValue(JSON.stringify({
        labels: [{ name: "agent-processing" }, { name: "bug" }],
      }));

      const status = await plugin.getStatus(ctx, "42");
      expect(status.labels).toEqual(["agent-processing", "bug"]);
    });

    it("should return empty labels on failure", async () => {
      const ctx = makeCtx();
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const status = await plugin.getStatus(ctx, "999");
      expect(status.labels).toEqual([]);
    });
  });

  describe("onStatusChange()", () => {
    it("should call gh issue edit to swap labels", async () => {
      const ctx = makeCtx();
      mockExecSync.mockReturnValue("");

      await plugin.onStatusChange(ctx, "42", { from: "ready-for-agent", to: "agent-processing" });

      const lastCall = mockExecSync.mock.calls.at(-1)!;
      expect(lastCall[0]).toContain("gh issue edit 42");
      expect(lastCall[0]).toContain("--remove-label");
      expect(lastCall[0]).toContain("--add-label");
    });
  });

  describe("onComment()", () => {
    it("should write temp file and call gh issue comment", async () => {
      const ctx = makeCtx();
      mockExecSync.mockReturnValue("");

      await plugin.onComment(ctx, "42", "✅ Done!");

      const commentCall = mockExecSync.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh issue comment")
      );
      expect(commentCall).toBeDefined();
    });
  });
});
