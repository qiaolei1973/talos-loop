import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubIssueSourcePlugin } from "../index.js";
import type { SourceContext, RepoRef } from "../../../types/plugin.js";

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

const defaultRepo: RepoRef = {
  name: "test-repo",
  path: "/tmp/test-repo",
  remote: "test/repo",
};

/**
 * Build a SourceContext. By default it provides ctx.repo (so owner/repo and
 * targetRepo are derived) and an empty config (default labels apply).
 */
function makeCtx(opts: {
  repo?: RepoRef | null;
  config?: Record<string, unknown>;
} = {}): SourceContext {
  return {
    config: opts.config ?? {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    repo: opts.repo === null ? undefined : opts.repo ?? defaultRepo,
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
    it("should create the four default labels via gh CLI against ctx.repo.remote", async () => {
      mockExecSync.mockReturnValue("");
      await plugin.init(makeCtx());

      const calls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh label create"),
      );
      expect(calls.length).toBe(4);
      for (const c of calls) {
        expect(c[0]).toContain("--repo test/repo");
      }
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
      // targetRepo comes from ctx.repo.name, not from config
      expect(issues.every((i) => i.targetRepo === "test-repo")).toBe(true);
      // gh commands target the resolved owner/repo
      expect(mockExecSync.mock.calls.some((c: any[]) => c[0]?.includes?.("--repo test/repo"))).toBe(true);
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

    it("should honor config.repo overriding ctx.repo.remote", async () => {
      const ctx = makeCtx({ config: { repo: "override/owner-repo" } });
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("agent-processing")) return "[]";
        if (cmd.includes("ready-for-agent")) return "[]";
        return "[]";
      });
      await plugin.discover(ctx);
      const listCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh issue list"),
      );
      for (const c of listCalls) {
        expect(c[0]).toContain("--repo override/owner-repo");
      }
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
      expect(cmd).toContain("--repo test/repo");
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

  describe("resolveRuntime() error paths", () => {
    it("should throw when neither config.repo nor ctx.repo.remote is available", async () => {
      const ctx = makeCtx({ repo: { name: "r", path: "/tmp/r" } }); // remote omitted
      await expect(plugin.discover(ctx)).rejects.toThrow(/owner\/repo/);
    });

    it("should throw when not bound to a repo (no owner/repo resolvable)", async () => {
      const ctx = makeCtx({ repo: null });
      // No ctx.repo → no remote to infer; error surfaces before the explicit repo check.
      await expect(plugin.discover(ctx)).rejects.toThrow(/owner\/repo/);
    });
  });

  describe("onComment()", () => {
    it("should write temp file and call gh issue comment", async () => {
      mockExecSync.mockReturnValue("");
      await plugin.onComment(makeCtx(), "42", "✅ Done!");

      const commentCall = mockExecSync.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("gh issue comment"),
      );
      expect(commentCall).toBeDefined();
      expect((commentCall![0] as string)).toContain("--repo test/repo");
    });
  });
});
