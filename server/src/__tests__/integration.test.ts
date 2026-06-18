import { describe, it, expect, vi } from "vitest";
import type {
  IssueSourcePlugin,
  ProjectContext,
  RepoRef,
  RawIssue,
  SubIssue,
  IssueStatus,
  IssueState,
  StatusTransition,
} from "../types/plugin.js";

/**
 * Contract-layer test (Seam A): verify the standard issue-state contract shape
 * and that a mock plugin satisfies the (issue #32) IssueSourcePlugin interface —
 * four methods: `list`/`writeLabel` (required) + `getItem?`/`writeComment?`
 * (optional). Conformance is enforced by the TypeScript compiler.
 */
describe("Issue-source contract (issue #32)", () => {
  it("RawIssue carries a standard state and optional downstream subIssues", () => {
    const raw: RawIssue = {
      sourceId: "42",
      url: "https://github.com/test/repo/issues/42",
      title: "Test issue",
      targetRepo: "test-repo",
      state: "queued",
    };
    expect(raw.sourceId).toBe("42");
    expect(raw.state).toBe("queued");
    expect((raw as any).metadata).toBeUndefined();

    // An in-review issue may carry a downstream attention signal.
    const withReview: RawIssue = {
      ...raw,
      state: "done",
      subIssues: [{ type: "review", resolved: false }],
    };
    expect(withReview.subIssues?.[0]).toEqual({ type: "review", resolved: false } as SubIssue);
  });

  it("IssueStatus.state is IssueState | null", () => {
    const active: IssueStatus = { state: "processing" };
    const offPipeline: IssueStatus = { state: null };
    expect(active.state).toBe("processing");
    expect(offPipeline.state).toBeNull();
  });

  it("StatusTransition uses standard states", () => {
    const t: StatusTransition = { from: "processing", to: "done" };
    expect(t.from).toBe("processing");
    expect(t.to).toBe("done");
  });

  it("IssueState covers exactly the three pipeline states (no failed)", () => {
    const states: IssueState[] = ["queued", "processing", "done"];
    expect(new Set(states).size).toBe(3);
  });

  it("a mock plugin satisfies IssueSourcePlugin (list + writeLabel + optional methods)", async () => {
    const writeLabelCalls: Array<{ transition: StatusTransition; targetRepo: string }> = [];
    const plugin: IssueSourcePlugin = {
      name: "mock",

      // The single read: returns every active issue with its standard state +
      // any downstream subIssues. Replaces the old discover() + listBoard().
      async list(_ctx: ProjectContext): Promise<RawIssue[]> {
        return [
          { sourceId: "1", url: "https://example.com/1", title: "Ready", targetRepo: "r", state: "queued" },
          { sourceId: "2", url: "https://example.com/2", title: "In review", targetRepo: "r", state: "done", subIssues: [{ type: "review", resolved: false }] },
        ];
      },

      // Optional freshness check before dispatch.
      async getItem(_ctx: ProjectContext, sourceId: string, _targetRepo: string): Promise<IssueStatus> {
        return sourceId === "1" ? { state: "queued" } : { state: null };
      },

      // The stage move: the server only ever initiates queued→processing and
      // processing→done.
      async writeLabel(_ctx: ProjectContext, _sourceId: string, t: StatusTransition, targetRepo: string): Promise<void> {
        writeLabelCalls.push({ transition: t, targetRepo });
      },

      // Optional comment (e.g. on exhausted retries).
      async writeComment(_ctx: ProjectContext, _sourceId: string, _comment: string, _targetRepo: string): Promise<void> {},
    };

    const ctx: ProjectContext = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      repos: [{ name: "r", path: "/tmp/r", remote: "owner/r" }],
      projectId: "owner/1",
    };

    const issues = await plugin.list(ctx);
    expect(issues.map((i) => i.state)).toEqual(["queued", "done"]);
    expect(issues[1].subIssues).toEqual([{ type: "review", resolved: false }]);

    expect((await plugin.getItem(ctx, "1", "r")).state).toBe("queued");

    await plugin.writeLabel(ctx, "1", { from: "queued", to: "processing" }, "r");
    expect(writeLabelCalls).toEqual([{ transition: { from: "queued", to: "processing" }, targetRepo: "r" }]);

    await plugin.writeComment(ctx, "1", "note", "r");
  });

  it("ProjectContext exposes repos[] and projectId", () => {
    const repos: RepoRef[] = [
      { name: "talos-loop", path: "/home/agent/talos-loop", remote: "qiaolei1973/talos-loop" },
    ];
    const ctx: ProjectContext = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      repos,
      projectId: "qiaolei1973/1",
    };
    expect(ctx.repos[0].name).toBe("talos-loop");
    expect(ctx.projectId).toBe("qiaolei1973/1");
  });
});
