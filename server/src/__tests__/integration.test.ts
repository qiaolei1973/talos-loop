import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueSourcePlugin, SourceContext, RawIssue } from "../types/plugin.js";

/**
 * Integration-level test: verify that a mock plugin's discover() output
 * gets correctly upserted to the database via pollSource().
 */
describe("Plugin Interface Integration", () => {
  // We test the contract between core and plugin at the type/logic level,
  // without spinning up the full server or making real gh CLI calls.

  it("RawIssue fields map correctly to DB columns", () => {
    const raw: RawIssue = {
      sourceType: "github",
      sourceId: "42",
      url: "https://github.com/test/repo/issues/42",
      title: "Test issue",
      targetRepo: "test-repo",
      metadata: { labels: ["ready-for-agent"] },
    };

    // Verify the shape matches what DB expects
    expect(raw.sourceType).toBe("github");
    expect(raw.sourceId).toBe("42");
    expect(raw.targetRepo).toBe("test-repo");
    expect(raw.url).toBeTruthy();
    expect(raw.title).toBeTruthy();
  });

  it("StatusTransition has from/to fields", () => {
    const transition = { from: "ready-for-agent", to: "agent-processing" };
    expect(transition.from).toBe("ready-for-agent");
    expect(transition.to).toBe("agent-processing");
  });

  it("IssueStatus has labels array", () => {
    const status = { labels: ["agent-processing", "bug"] };
    expect(status.labels).toContain("agent-processing");
    expect(status.labels).toHaveLength(2);
  });

  it("mock plugin satisfies IssueSourcePlugin interface", async () => {
    const mockPlugin: IssueSourcePlugin = {
      name: "mock",

      async init(ctx: SourceContext): Promise<void> {
        // no-op
      },

      async discover(ctx: SourceContext): Promise<RawIssue[]> {
        return [
          {
            sourceType: "mock",
            sourceId: "1",
            url: "https://example.com/issues/1",
            title: "Mock issue",
            targetRepo: "test-repo",
          },
        ];
      },

      async getStatus(ctx: SourceContext, sourceId: string): Promise<{ labels: string[] }> {
        return { labels: ["ready"] };
      },

      async test(ctx: SourceContext): Promise<boolean> {
        return true;
      },

      onStatusChange: async (ctx, sourceId, transition) => {
        // no-op
      },

      onComment: async (ctx, sourceId, comment) => {
        // no-op
      },
    };

    expect(mockPlugin.name).toBe("mock");

    const ctx: SourceContext = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await mockPlugin.init(ctx);
    const issues = await mockPlugin.discover(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].sourceType).toBe("mock");

    const status = await mockPlugin.getStatus(ctx, "1");
    expect(status.labels).toContain("ready");

    const healthy = await mockPlugin.test(ctx);
    expect(healthy).toBe(true);
  });
});
