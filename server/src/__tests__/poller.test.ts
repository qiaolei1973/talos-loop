import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawIssue } from "../types/plugin.js";

// --- per-test controllable state ---
let listIssues: RawIssue[] = [];
let listError: Error | null = null;

const mockPlugin = {
  name: "github",
  async list() {
    if (listError) throw listError;
    return listIssues;
  },
};

const mockUpsertIssue = vi.fn();
const mockSetProjectBoard = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("../config.js", () => ({
  getEnabledProjects: () => [
    {
      projectId: "qiaolei1973/1",
      projectType: "github",
      enabled: true,
      repos: [{ name: "talos-loop", path: "/tmp/talos-loop", remote: "qiaolei1973/talos-loop" }],
    },
  ],
  buildProjectContext: () => ({
    config: {},
    logger: mockLogger,
    repos: [{ name: "talos-loop", path: "/tmp/talos-loop", remote: "qiaolei1973/talos-loop" }],
    projectId: "qiaolei1973/1",
  }),
}));

vi.mock("../db/index.js", () => ({
  upsertIssue: (...args: any[]) => mockUpsertIssue(...args),
}));

vi.mock("../plugins/loader.js", () => ({
  resolvePlugin: async () => mockPlugin,
}));

vi.mock("../services/boardSnapshot.js", () => ({
  setProjectBoard: (...args: any[]) => mockSetProjectBoard(...args),
}));

vi.mock("../services/logger.js", () => ({
  createLogger: () => mockLogger,
}));

/**
 * issue #32: the poller makes ONE read (plugin.list()) that replaces the old
 * discover() + listBoard() pair. It upserts every returned active issue for the
 * identity/display cache, rebuilds the in-memory board snapshot from the standard
 * `state`s (the display-status input), and carries `subIssues` into `discovered`
 * so the dispatcher can route review dispatch.
 */
describe("poller reads via list() and rebuilds the snapshot (issue #32)", () => {
  beforeEach(() => {
    listIssues = [];
    listError = null;
    mockUpsertIssue.mockReset();
    mockSetProjectBoard.mockReset();
    mockLogger.error.mockReset();
    // upsertIssue returns a minimal issue row keyed off the source id.
    mockUpsertIssue.mockImplementation((_pid: string, _pt: string, sid: string) => ({
      id: Number(sid),
      project_id: "qiaolei1973/1",
      project_type: "github",
      source_id: sid,
      target_repo: "talos-loop",
      url: `u${sid}`,
      title: `T${sid}`,
      created_at: "",
      updated_at: "",
    }));
  });

  it("refreshes the snapshot from list().state and upserts every active item", async () => {
    listIssues = [
      { sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" },
      { sourceId: "11", url: "u11", title: "T11", targetRepo: "talos-loop", state: "processing" },
      { sourceId: "12", url: "u12", title: "T12", targetRepo: "talos-loop", state: "done" },
    ];

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    // Every active item is upserted for identity/display cache.
    expect(mockUpsertIssue).toHaveBeenCalledWith("qiaolei1973/1", "github", "9", "talos-loop", "u9", "T9");
    expect(results[0].discovered).toHaveLength(3);
    expect(results[0].error).toBeUndefined();

    // The snapshot slice is keyed by sourceId → standard state.
    expect(mockSetProjectBoard).toHaveBeenCalledWith("qiaolei1973/1", expect.any(Map));
    const slice = mockSetProjectBoard.mock.calls[0][1] as Map<string, string>;
    expect(slice.get("9")).toBe("queued");
    expect(slice.get("11")).toBe("processing");
    expect(slice.get("12")).toBe("done");

    // The standard state + subIssues are carried into discovered for routing.
    expect(results[0].discovered.map((d) => d.state)).toEqual(["queued", "processing", "done"]);
  });

  it("carries a review subIssue into discovered for an in-review issue", async () => {
    listIssues = [
      {
        sourceId: "12",
        url: "u12",
        title: "T12",
        targetRepo: "talos-loop",
        state: "done",
        subIssues: [{ type: "review", resolved: false }],
      },
    ];

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    expect(results[0].discovered[0].subIssues).toEqual([{ type: "review", resolved: false }]);
  });

  it("surfaces a list() failure as an error and does NOT refresh the snapshot", async () => {
    listError = new Error("rate limited");

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    // The board-read failure surfaces prominently (no silent empty board)…
    expect(results[0].error).toMatch(/rate limited/);
    expect(results[0].discovered).toEqual([]);
    // …and the snapshot is simply not refreshed this cycle.
    expect(mockSetProjectBoard).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("does not persist workflow status — only identity/display cache via upsertIssue", async () => {
    // The db mock exposes only upsertIssue. The poller must not call any
    // status-writing helper — the snapshot is the sole (in-memory) write.
    listIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];

    const { pollAll } = await import("../services/poller.js");
    await pollAll();

    expect(mockUpsertIssue).toHaveBeenCalledTimes(1);
    expect(mockSetProjectBoard).toHaveBeenCalledTimes(1);
  });
});
