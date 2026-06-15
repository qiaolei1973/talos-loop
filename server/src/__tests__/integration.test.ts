import { describe, it, expect, vi } from "vitest";
import type {
  IssueSourcePlugin,
  ProjectContext,
  RepoRef,
  RawIssue,
  IssueStatus,
  IssueState,
  StatusTransition,
} from "../types/plugin.js";

/**
 * Contract-layer test (Seam A): verify the standard issue-state contract shape
 * and that a mock plugin satisfies the IssueSourcePlugin interface. Conformance
 * is enforced by the TypeScript compiler.
 */
describe("Issue-state contract", () => {
  it("RawIssue carries a standard state and no metadata", () => {
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

  it("a mock plugin satisfies IssueSourcePlugin (skip + targetRepo)", async () => {
    const calls: Array<{ transition: StatusTransition; targetRepo: string }> = [];
    const plugin: IssueSourcePlugin = {
      name: "mock",

      async init(): Promise<void> {},

      async discover(): Promise<RawIssue[]> {
        return [{ sourceId: "1", url: "https://example.com/1", title: "Ready", targetRepo: "r", state: "queued" }];
      },

      async getStatus(_ctx: ProjectContext, sourceId: string, _targetRepo: string): Promise<IssueStatus> {
        return sourceId === "1" ? { state: "queued" } : { state: null };
      },

      async transition(_ctx: ProjectContext, _sourceId: string, t: StatusTransition, targetRepo: string): Promise<void> {
        calls.push({ transition: t, targetRepo });
      },

      async test(): Promise<boolean> {
        return true;
      },

      async skip(_ctx: ProjectContext, _sourceId: string, _targetRepo: string, _reason: string): Promise<void> {},
    };

    const ctx: ProjectContext = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      repos: [{ name: "r", path: "/tmp/r", remote: "owner/r" }],
      projectId: "owner/1",
    };

    await plugin.init(ctx);
    const issues = await plugin.discover(ctx);
    expect(issues.map((i) => i.state)).toEqual(["queued"]);

    expect((await plugin.getStatus(ctx, "1", "r")).state).toBe("queued");

    await plugin.transition(ctx, "1", { from: "queued", to: "processing" }, "r");
    expect(calls).toEqual([{ transition: { from: "queued", to: "processing" }, targetRepo: "r" }]);

    await plugin.skip(ctx, "1", "r", "not enough info");

    expect(await plugin.test(ctx)).toBe(true);
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
