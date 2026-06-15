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
      await plugin.init(makeCtx());

      const calls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh label create")
      );
      expect(calls.length).toBe(4);
    });
  });

  describe("test()", () => {
    it("should return true when gh auth succeeds", async () => {
      mockExecSync.mockReturnValue("");
      expect(await plugin.test(makeCtx())).toBe(true);
    });

    it("should return false when gh auth fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not authenticated");
      });
      expect(await plugin.test(makeCtx())).toBe(false);
    });
  });

  describe("discover()", () => {
    it("should tag each RawIssue with its standard state and carry no metadata", async () => {
      const ctx = makeCtx();
      const triggerIssue = { number: 1, title: "Queued", url: "u1", labels: [{ name: "ready-for-agent" }] };
      const processingIssue = { number: 2, title: "Processing", url: "u2", labels: [{ name: "agent-processing" }] };

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("agent-processing")) return JSON.stringify([processingIssue]);
        if (cmd.includes("ready-for-agent")) return JSON.stringify([triggerIssue]);
        return "[]";
      });

      const issues = await plugin.discover(ctx);
      expect(issues).toHaveLength(2);

      const byId = Object.fromEntries(issues.map((i) => [i.sourceId, i]));
      expect(byId["1"].state).toBe("queued");
      expect(byId["2"].state).toBe("processing");
      expect((issues[0] as any).metadata).toBeUndefined();
    });

    it("should dedupe, preferring processing over queued when an issue carries both markers", async () => {
      const ctx = makeCtx();
      const both = {
        number: 1,
        title: "Dupe",
        url: "u1",
        labels: [{ name: "ready-for-agent" }, { name: "agent-processing" }],
      };
      mockExecSync.mockImplementation(() => JSON.stringify([both]));

      const issues = await plugin.discover(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].state).toBe("processing");
    });

    it("should return empty array when gh fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("gh CLI error");
      });
      expect(await plugin.discover(makeCtx())).toEqual([]);
    });
  });

  describe("getStatus()", () => {
    const viewReturns = (labels: string[]) =>
      mockExecSync.mockReturnValue(JSON.stringify({ labels: labels.map((name) => ({ name })) }));

    it("should map the trigger label to queued", async () => {
      viewReturns(["ready-for-agent", "bug"]);
      expect((await plugin.getStatus(makeCtx(), "1")).state).toBe("queued");
    });

    it("should resolve priority: failed > done > processing > queued", async () => {
      viewReturns(["ready-for-agent", "agent-processing"]);
      expect((await plugin.getStatus(makeCtx(), "1")).state).toBe("processing");

      viewReturns(["ready-for-agent", "agent-done"]);
      expect((await plugin.getStatus(makeCtx(), "1")).state).toBe("done");

      viewReturns(["agent-done", "agent-failed"]);
      expect((await plugin.getStatus(makeCtx(), "1")).state).toBe("failed");
    });

    it("should return null when no pipeline label is present", async () => {
      viewReturns(["bug", "question"]);
      expect((await plugin.getStatus(makeCtx(), "1")).state).toBeNull();
    });

    it("should return null on gh failure", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect((await plugin.getStatus(makeCtx(), "999")).state).toBeNull();
    });
  });

  describe("transition()", () => {
    it("should remove the from-state label and add the to-state label", async () => {
      mockExecSync.mockReturnValue("");
      await plugin.transition(makeCtx(), "42", { from: "queued", to: "processing" });

      const cmd = mockExecSync.mock.calls.at(-1)![0] as string;
      expect(cmd).toContain("gh issue edit 42");
      expect(cmd).toContain(`--remove-label "ready-for-agent"`);
      expect(cmd).toContain(`--add-label "agent-processing"`);
    });

    it("should map done/failed states to their labels", async () => {
      mockExecSync.mockReturnValue("");
      await plugin.transition(makeCtx(), "7", { from: "processing", to: "failed" });

      const cmd = mockExecSync.mock.calls.at(-1)![0] as string;
      expect(cmd).toContain(`--remove-label "agent-processing"`);
      expect(cmd).toContain(`--add-label "agent-failed"`);
    });
  });

  describe("onComment()", () => {
    it("should write temp file and call gh issue comment", async () => {
      mockExecSync.mockReturnValue("");
      await plugin.onComment(makeCtx(), "42", "✅ Done!");

      const commentCall = mockExecSync.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh issue comment")
      );
      expect(commentCall).toBeDefined();
    });
  });
});
