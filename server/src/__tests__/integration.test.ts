import { describe, it, expect, vi } from "vitest";
import type {
  IssueSourcePlugin,
  SourceContext,
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

  it("IssueState covers exactly the four pipeline states", () => {
    const states: IssueState[] = ["queued", "processing", "done", "failed"];
    expect(new Set(states).size).toBe(4);
  });

  it("a mock plugin satisfies the IssueSourcePlugin interface (transition required)", async () => {
    const calls: StatusTransition[] = [];
    const plugin: IssueSourcePlugin = {
      name: "mock",

      async init(): Promise<void> {},

      async discover(): Promise<RawIssue[]> {
        return [
          { sourceId: "1", url: "https://example.com/1", title: "Queued", targetRepo: "r", state: "queued" },
          { sourceId: "2", url: "https://example.com/2", title: "Processing", targetRepo: "r", state: "processing" },
        ];
      },

      async getStatus(_ctx: SourceContext, sourceId: string): Promise<IssueStatus> {
        return sourceId === "2" ? { state: "processing" } : { state: "queued" };
      },

      async transition(_ctx: SourceContext, _sourceId: string, t: StatusTransition): Promise<void> {
        calls.push(t);
      },

      async test(): Promise<boolean> {
        return true;
      },

      // onComment is optional and intentionally omitted.
    };

    const ctx: SourceContext = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    };

    await plugin.init(ctx);
    const issues = await plugin.discover(ctx);
    expect(issues.map((i) => i.state)).toEqual(["queued", "processing"]);

    expect((await plugin.getStatus(ctx, "1")).state).toBe("queued");
    expect((await plugin.getStatus(ctx, "2")).state).toBe("processing");

    await plugin.transition(ctx, "1", { from: "queued", to: "processing" });
    expect(calls).toEqual([{ from: "queued", to: "processing" }]);

    expect(await plugin.test(ctx)).toBe(true);
  });
});
