import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubIssueSourcePlugin } from "../index.js";
import type { ProjectContext, RepoRef } from "../../../types/plugin.js";

// Mock execAsync from utils
vi.mock("../../../utils/execAsync.js", () => ({
  execAsync: vi.fn(),
}));

// Mock fs/promises for writeComment / commentIfMissing tmp files
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

import { execAsync } from "../../../utils/execAsync.js";

const mockExecAsync = execAsync as unknown as ReturnType<typeof vi.fn>;

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

/**
 * Drive the gh CLI mock. The active-board read (gh project item-list) returns the
 * declared `items`; a done item's review-thread probe (gh api graphql) returns the
 * cross-referenced-PR thread shape; --json labels/comments drive getItem/the
 * drift comment; gh project view/field-list drive the lazy project-meta cache.
 */
function ghMock(opts: {
  items?: any[];
  labels?: any[];
  comments?: any[];
  /** reviewThreads nodes for the graphql PR-thread probe (isResolved each). */
  reviewThreads?: Array<{ isResolved: boolean }>;
  itemListThrows?: boolean;
} = {}) {
  return (cmd: string) => {
    let result = "";
    if (cmd.includes("gh project view")) result = JSON.stringify({ id: "PVT_test", number: 1 });
    else if (cmd.includes("gh project field-list")) result = JSON.stringify(FIELD_LIST);
    else if (cmd.includes("gh project item-list")) {
      if (opts.itemListThrows) return Promise.reject(new Error("rate limited"));
      result = JSON.stringify({ items: opts.items ?? [] });
    }
    else if (cmd.includes("gh api graphql")) {
      // The list() review probe walks the issue's cross-referenced PR timeline.
      result = JSON.stringify({
        data: {
          repository: {
            issue: {
              timelineItems: { nodes: [{ source: { reviewThreads: { nodes: opts.reviewThreads ?? [] } } }] },
            },
          },
        },
      });
    }
    else if (cmd.includes("--json labels")) result = JSON.stringify({ labels: opts.labels ?? [] });
    else if (cmd.includes("--json comments")) result = JSON.stringify({ comments: opts.comments ?? [] });
    // gh issue comment / gh project item-edit return empty
    return Promise.resolve({ stdout: result, stderr: "" });
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
    content: { number, title: `Issue ${number}`, url: `https://example.com/${number}`, repository, type: "Issue" },
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

  describe("list() — the single active-board read (issue #32)", () => {
    it("maps board columns to standard states and returns only declared-repo items", async () => {
      mockExecAsync.mockImplementation(
        ghMock({
          items: [
            item(9, "Ready", "qiaolei1973/talos-loop"), // → queued
            item(11, "In progress", "qiaolei1973/talos-loop"), // → processing
            item(12, "In review", "qiaolei1973/talos-loop"), // → done (no unresolved threads below)
            item(13, "Backlog", "qiaolei1973/talos-loop"), // terminal → excluded
            item(14, "Ready", "qiaolei1973/other"), // config drift: repo not declared → excluded
          ],
          reviewThreads: [], // no unresolved threads for the in-review item
        }),
      );

      const issues = await plugin.list(makeCtx());

      const byId = new Map(issues.map((i) => [i.sourceId, i]));
      expect([...byId.keys()].sort()).toEqual(["11", "12", "9"]);
      expect(byId.get("9")!.state).toBe("queued");
      expect(byId.get("11")!.state).toBe("processing");
      expect(byId.get("12")!.state).toBe("done");
      // No review subIssues when the linked PR has no unresolved threads.
      expect(byId.get("12")!.subIssues).toBeUndefined();
      // Identity/display fields pass through.
      expect(byId.get("9")!.targetRepo).toBe("talos-loop");
      expect(byId.get("9")!.url).toBe("https://example.com/9");
      expect(byId.get("9")!.title).toBe("Issue 9");
    });

    it("flags an in-review issue with a review subIssue when the linked PR has unresolved threads", async () => {
      mockExecAsync.mockImplementation(
        ghMock({
          items: [item(12, "In review", "qiaolei1973/talos-loop")],
          reviewThreads: [{ isResolved: false }, { isResolved: true }], // one unresolved
        }),
      );

      const issues = await plugin.list(makeCtx());
      expect(issues[0].state).toBe("done");
      expect(issues[0].subIssues).toEqual([{ type: "review", resolved: false }]);
    });

    it("omits the review subIssue when the linked PR threads are all resolved", async () => {
      mockExecAsync.mockImplementation(
        ghMock({
          items: [item(12, "In review", "qiaolei1973/talos-loop")],
          reviewThreads: [{ isResolved: true }],
        }),
      );

      const issues = await plugin.list(makeCtx());
      expect(issues[0].subIssues).toBeUndefined();
    });

    it("throws on board-read failure instead of returning an empty array (issue #13)", async () => {
      // project-meta resolves, but the item-list read fails.
      mockExecAsync.mockImplementation(ghMock({ itemListThrows: true }));

      await expect(plugin.list(makeCtx())).rejects.toThrow(/rate limited/);
    });

    it("ignores a config-drift repo (repo not declared) with a warning", async () => {
      mockExecAsync.mockImplementation(
        ghMock({
          items: [item(14, "Ready", "qiaolei1973/other")],
          comments: [], // commentIfMissing probes existing comments before posting
        }),
      );

      const ctx = makeCtx();
      const issues = await plugin.list(ctx);
      expect(issues).toEqual([]);
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/not declared in projects.json/i));
    });
  });

  describe("getItem() — pre-dispatch freshness check", () => {
    it("maps the trigger label (no skipped) to queued", async () => {
      mockExecAsync.mockImplementation(ghMock({ labels: [{ name: "ready-for-agent" }, { name: "bug" }] }));
      expect((await plugin.getItem(makeCtx(), "9", "talos-loop")).state).toBe("queued");
    });

    it("returns null when the trigger label is absent", async () => {
      mockExecAsync.mockImplementation(ghMock({ labels: [{ name: "bug" }] }));
      expect((await plugin.getItem(makeCtx(), "9", "talos-loop")).state).toBeNull();
    });

    it("returns null on gh failure (warns, no silent crash)", async () => {
      mockExecAsync.mockImplementation(() => {
        return Promise.reject(new Error("not found"));
      });
      const ctx = makeCtx();
      expect((await plugin.getItem(ctx, "999", "talos-loop")).state).toBeNull();
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/read failed/i));
    });
  });

  describe("writeLabel() — stage transition via gh project item-edit", () => {
    it("edits the project item to the target status option", async () => {
      mockExecAsync.mockImplementation(ghMock({ items: [item(9, "Ready")] }));
      await plugin.writeLabel(makeCtx(), "9", { from: "queued", to: "processing" }, "talos-loop");

      const editCmd = mockExecAsync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh project item-edit"));
      expect(editCmd).toBeDefined();
      expect(editCmd).toContain("--id I_9");
      expect(editCmd).toContain("--field-id F_status");
      expect(editCmd).toContain("--project-id PVT_test");
      // processing → "In progress" → o_progress
      expect(editCmd).toContain("--single-select-option-id o_progress");
    });

    it("maps done → 'In review' option (case/space-tolerant option lookup)", async () => {
      mockExecAsync.mockImplementation(ghMock({ items: [item(9, "In progress")] }));
      await plugin.writeLabel(makeCtx(), "9", { from: "processing", to: "done" }, "talos-loop");
      const editCmd = mockExecAsync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh project item-edit"));
      // done → "In review" → o_review
      expect(editCmd).toContain("--single-select-option-id o_review");
    });

    it("warns on board-read failure and does not attempt an edit (issue #13)", async () => {
      mockExecAsync.mockImplementation(ghMock({ itemListThrows: true }));
      const ctx = makeCtx();
      await plugin.writeLabel(ctx, "9", { from: "queued", to: "processing" }, "talos-loop");

      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/board read failed/i));
      const editCmd = mockExecAsync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh project item-edit"));
      expect(editCmd).toBeUndefined();
    });
  });

  describe("writeComment() — leave a comment on an issue", () => {
    it("posts the comment body via gh issue comment --body-file", async () => {
      mockExecAsync.mockImplementation(ghMock());
      await plugin.writeComment(makeCtx(), "9", "hello world", "talos-loop");

      const commentCmd = mockExecAsync.mock.calls
        .map((c: any[]) => c[0] as string)
        .find((cmd) => cmd.includes("gh issue comment"));
      expect(commentCmd).toContain("--repo qiaolei1973/talos-loop");
      expect(commentCmd).toContain("--body-file");
    });
  });
});
