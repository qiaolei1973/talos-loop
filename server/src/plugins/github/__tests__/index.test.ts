import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubIssueSourcePlugin } from "../index.js";
import type { ProjectContext, RepoRef } from "../../../types/plugin.js";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Mock fs for onComment / commentIfMissing tmp files
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

/** Real gh project field-list shape: Status is a single-select with 5 options (note lowercase p/r). */
const FIELD_LIST = {
  fields: [
    { id: "F_title", name: "Title", type: "ProjectV2Field" },
    {
      id: "F_status",
      name: "Status",
      type: "ProjectV2SingleSelectField",
      options: [
        { id: "o_backlog", name: "Backlog" },
        { id: "o_ready", name: "Ready" },
        { id: "o_progress", name: "In progress" },
        { id: "o_review", name: "In review" },
        { id: "o_done", name: "Done" },
      ],
    },
  ],
};

function ghMock(opts: { items?: any[]; labels?: any[]; comments?: any[] } = {}) {
  return (cmd: string) => {
    if (cmd.includes("gh project view")) return JSON.stringify({ id: "PVT_test", number: 1 });
    if (cmd.includes("gh project field-list")) return JSON.stringify(FIELD_LIST);
    if (cmd.includes("gh project item-list")) return JSON.stringify({ items: opts.items ?? [] });
    if (cmd.includes("--json labels")) return JSON.stringify({ labels: opts.labels ?? [] });
    if (cmd.includes("--json comments")) return JSON.stringify({ comments: opts.comments ?? [] });
    return ""; // gh label create / gh issue edit / gh issue comment / gh project item-edit
  };
}

const defaultRepo: RepoRef = {
  name: "talos-loop",
  path: "/tmp/talos-loop",
  remote: "qiaolei1973/talos-loop",
};

function makeCtx(opts: { repos?: RepoRef[]; config?: Record<string, unknown>; projectId?: string } = {}): ProjectContext {
  return {
    config: opts.config ?? {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repos: opts.repos ?? [defaultRepo],
    projectId: opts.projectId ?? "qiaolei1973/1",
  };
}

function item(number: number, status: string, repository = "qiaolei1973/talos-loop") {
  return {
    id: `I_${number}`,
    status,
    content: { number, title: `Issue ${number}`, url: `u${number}`, repository, type: "Issue" },
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
    it("resolves project meta (view + field-list) and creates the skipped label per repo", async () => {
      mockExecSync.mockImplementation(ghMock());
      await plugin.init(makeCtx());

      const labelCalls = mockExecSync.mock.calls
        .map((c: any[]) => c[0] as string)
        .filter((cmd) => cmd.includes("gh label create"));
      expect(labelCalls).toHaveLength(1);
      expect(labelCalls[0]).toContain("--repo qiaolei1973/talos-loop");
      expect(labelCalls[0]).toContain('"skipped"');
    });

    it("skips repos without a remote with a warning", async () => {
      mockExecSync.mockImplementation(ghMock());
      const ctx = makeCtx({ repos: [{ name: "r", path: "/tmp/r" }] }); // no remote
      await plugin.init(ctx);
      const labelCalls = mockExecSync.mock.calls
        .map((c: any[]) => c[0] as string)
        .filter((cmd) => cmd.includes("gh label create"));
      expect(labelCalls).toHaveLength(0);
      expect(ctx.logger.warn).toHaveBeenCalled();
    });
  });

  describe("discover()", () => {
    it("returns only Ready items whose repo is declared, tagged queued", async () => {
      mockExecSync.mockImplementation(
        ghMock({
          items: [
            item(9, "Ready", "qiaolei1973/talos-loop"),
            item(10, "Ready", "qiaolei1973/other"), // drift: repo not declared
            item(11, "In progress", "qiaolei1973/talos-loop"), // not Ready
          ],
        }),
      );
      await plugin.init(makeCtx());
      const issues = await plugin.discover(makeCtx());

      expect(issues).toHaveLength(1);
      expect(issues[0].sourceId).toBe("9");
      expect(issues[0].state).toBe("queued");
      expect(issues[0].targetRepo).toBe("talos-loop");
    });

    it("returns empty when gh fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("gh CLI error");
      });
      await expect(plugin.discover(makeCtx())).resolves.toEqual([]);
    });
  });

  describe("getStatus()", () => {
    it("maps ready-for-agent (no skipped) to queued", async () => {
      mockExecSync.mockImplementation(ghMock({ labels: [{ name: "ready-for-agent" }, { name: "bug" }] }));
      expect((await plugin.getStatus(makeCtx(), "9", "talos-loop")).state).toBe("queued");
    });

    it("returns null when skipped label is present", async () => {
      mockExecSync.mockImplementation(ghMock({ labels: [{ name: "ready-for-agent" }, { name: "skipped" }] }));
      expect((await plugin.getStatus(makeCtx(), "9", "talos-loop")).state).toBeNull();
    });

    it("returns null when no trigger label", async () => {
      mockExecSync.mockImplementation(ghMock({ labels: [{ name: "bug" }] }));
      expect((await plugin.getStatus(makeCtx(), "9", "talos-loop")).state).toBeNull();
    });

    it("returns null on gh failure", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect((await plugin.getStatus(makeCtx(), "999", "talos-loop")).state).toBeNull();
    });
  });

  describe("transition()", () => {
    it("edits the project item to the target status option", async () => {
      mockExecSync.mockImplementation(ghMock({ items: [item(9, "Ready")] }));
      await plugin.init(makeCtx());
      await plugin.transition(makeCtx(), "9", { from: "queued", to: "processing" }, "talos-loop");

      const editCmd = mockExecSync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh project item-edit"));
      expect(editCmd).toBeDefined();
      expect(editCmd).toContain("--id I_9");
      expect(editCmd).toContain("--field-id F_status");
      expect(editCmd).toContain("--project-id PVT_test");
      // processing → "In progress" → o_progress
      expect(editCmd).toContain("--single-select-option-id o_progress");
    });

    it("matches option names case/space-tolerantly (real names use lowercase p/r)", async () => {
      mockExecSync.mockImplementation(ghMock({ items: [item(9, "In progress")] }));
      await plugin.init(makeCtx());
      await plugin.transition(makeCtx(), "9", { from: "processing", to: "done" }, "talos-loop");
      const editCmd = mockExecSync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh project item-edit"));
      // done → "In review" → o_review
      expect(editCmd).toContain("--single-select-option-id o_review");
    });
  });

  describe("skip()", () => {
    it("adds skipped label, comments, and returns status to Ready", async () => {
      mockExecSync.mockImplementation(ghMock({ items: [item(9, "In progress")] }));
      await plugin.init(makeCtx());
      await plugin.skip(makeCtx(), "9", "talos-loop", "needs more info");

      const cmds = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
      expect(cmds.some((c) => c.includes("gh issue edit 9") && c.includes('--add-label "skipped"'))).toBe(true);
      expect(cmds.some((c) => c.includes("gh issue comment 9"))).toBe(true);
      const editCmds = cmds.filter((c) => c.includes("gh project item-edit"));
      expect(editCmds).toHaveLength(1);
      // skip rolls back to queued → "Ready" → o_ready
      expect(editCmds[0]).toContain("--single-select-option-id o_ready");
    });
  });

  describe("capabilities()", () => {
    it("declares submit-pr, comment, and skip with the required params", () => {
      const caps = plugin.capabilities();
      const byAction = new Map(caps.map((c) => [c.action, c]));

      expect(byAction.has("submit-pr")).toBe(true);
      expect(byAction.has("comment")).toBe(true);
      expect(byAction.has("skip")).toBe(true);

      for (const cap of caps) {
        expect(typeof cap.description).toBe("string");
        expect(cap.description.length).toBeGreaterThan(0);
        expect(Array.isArray(cap.params)).toBe(true);
        for (const p of cap.params) {
          expect(typeof p.name).toBe("string");
          expect(typeof p.description).toBe("string");
        }
      }
      // submit-pr must accept the branch parameter the prompt tells the agent to send.
      expect(byAction.get("submit-pr")!.params.map((p) => p.name)).toContain("branch");
    });
  });

  describe("submitPr()", () => {
    it("runs gh pr create with the branch/sourceId/repo and returns the URL", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh pr create")) return JSON.stringify({ url: "https://github.com/qiaolei1973/talos-loop/pull/7" });
        return "";
      });

      const url = await plugin.submitPr(makeCtx(), "9", "feat/x", "talos-loop");

      expect(url).toBe("https://github.com/qiaolei1973/talos-loop/pull/7");
      const createCmd = mockExecSync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh pr create"));
      expect(createCmd).toBeDefined();
      expect(createCmd).toContain("--head feat/x");
      expect(createCmd).toContain("--base main");
      expect(createCmd).toContain("--repo qiaolei1973/talos-loop");
      expect(createCmd).toContain("--json url");
      // Title references the source issue so GitHub links the PR.
      expect(createCmd).toContain('Closes #9');
    });

    it("throws when the repo has no remote", async () => {
      mockExecSync.mockImplementation(() => "");
      const ctx = makeCtx({ repos: [{ name: "talos-loop", path: "/tmp/talos-loop" }] }); // no remote
      await expect(plugin.submitPr(ctx, "9", "feat/x", "talos-loop")).rejects.toThrow(/no remote/);
    });

    it("throws when the PR URL cannot be parsed from gh output", async () => {
      mockExecSync.mockImplementation(() => JSON.stringify({})); // no url field
      await expect(plugin.submitPr(makeCtx(), "9", "feat/x", "talos-loop")).rejects.toThrow(/parse PR URL/);
    });
  });
});
