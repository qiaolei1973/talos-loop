import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Issue } from "../db/index.js";

// --- per-test controllable state ---
let discoveredIssues: any[] = [];
let boardItems: any[] = [];
let listBoardError: Error | null = null;
let quotaStatus: any = { available: true, remaining: 99999, limit: 5000 };

const mockPlugin = {
  name: "github",
  async discover() {
    return discoveredIssues;
  },
  async listBoard() {
    if (listBoardError) throw listBoardError;
    return boardItems;
  },
  async checkQuota() {
    return quotaStatus;
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
  loadConfig: () => ({ quotaThreshold: 200 }),
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

function issueFromSource(sourceId: string): Issue {
  return {
    id: Number(sourceId),
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: sourceId,
    target_repo: "talos-loop",
    url: `u${sourceId}`,
    title: `T${sourceId}`,
    created_at: "",
    updated_at: "",
  };
}

/**
 * Seam 3 (issue #13): the poller rebuilds the in-memory board snapshot each cycle
 * (the display-status input) from the plugin's full board listing, and persists
 * NOTHING for workflow status — only identity/display cache via upsertIssue.
 */
describe("poller builds the board snapshot (issue #13)", () => {
  beforeEach(() => {
    discoveredIssues = [];
    boardItems = [];
    listBoardError = null;
    quotaStatus = { available: true, remaining: 99999, limit: 5000 };
    mockUpsertIssue.mockReset();
    mockSetProjectBoard.mockReset();
    mockLogger.warn.mockReset();
    mockUpsertIssue.mockImplementation(
      (_pid: string, _pt: string, sid: string) => issueFromSource(sid),
    );
  });

  it("refreshes the snapshot from listBoard across all board columns", async () => {
    discoveredIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];
    boardItems = [
      { sourceId: "9", repository: "qiaolei1973/talos-loop", boardStatus: "Ready", url: "u9", title: "T9" },
      { sourceId: "11", repository: "qiaolei1973/talos-loop", boardStatus: "In progress", url: "u11", title: "T11" },
      { sourceId: "12", repository: "qiaolei1973/talos-loop", boardStatus: "Done", url: "u12", title: "T12" },
      // Config drift: repo not declared → excluded from the snapshot slice.
      { sourceId: "13", repository: "qiaolei1973/other", boardStatus: "Ready", url: "u13", title: "T13" },
    ];

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    // Discovered (Ready) issues are upserted for identity/display cache.
    expect(mockUpsertIssue).toHaveBeenCalledWith("qiaolei1973/1", "github", "9", "talos-loop", "u9", "T9");
    expect(results[0].discovered).toHaveLength(1);

    // The snapshot slice covers every declared-repo item, keyed by sourceId.
    expect(mockSetProjectBoard).toHaveBeenCalledWith("qiaolei1973/1", expect.any(Map));
    const slice = mockSetProjectBoard.mock.calls[0][1] as Map<string, string>;
    expect(slice.get("9")).toBe("Ready");
    expect(slice.get("11")).toBe("In progress");
    expect(slice.get("12")).toBe("Done");
    expect(slice.has("13")).toBe(false); // drift repo skipped
  });

  it("warns (not throws) when listBoard fails, leaving discovery intact", async () => {
    discoveredIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];
    listBoardError = new Error("rate limited");

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    // Discovery still upserts the Ready issue…
    expect(mockUpsertIssue).toHaveBeenCalled();
    expect(results[0].discovered).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    // …and the snapshot isn't refreshed, but the board-read failure is surfaced
    // prominently instead of swallowed as an empty board.
    expect(mockSetProjectBoard).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/board read failed/i));
  });

  it("does not persist workflow status — only identity/display cache via upsertIssue", async () => {
    // The db mock exposes upsertIssue and nothing else. Poller must not import or
    // call any status-writing helper (updateIssueStatus no longer exists).
    discoveredIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];
    boardItems = [{ sourceId: "9", repository: "qiaolei1973/talos-loop", boardStatus: "Ready", url: "u9", title: "T9" }];

    const { pollAll } = await import("../services/poller.js");
    await pollAll();

    expect(mockUpsertIssue).toHaveBeenCalledTimes(1);
    // Snapshot is the only other write — and it is in-memory (setProjectBoard).
    expect(mockSetProjectBoard).toHaveBeenCalledTimes(1);
  });
});

describe("poller gates polling on GraphQL quota", () => {
  beforeEach(() => {
    discoveredIssues = [];
    boardItems = [];
    listBoardError = null;
    quotaStatus = { available: true, remaining: 99999, limit: 5000 };
    mockUpsertIssue.mockReset();
    mockSetProjectBoard.mockReset();
    mockLogger.warn.mockReset();
    mockUpsertIssue.mockImplementation(
      (_pid: string, _pt: string, sid: string) => issueFromSource(sid),
    );
  });

  it("skips discover/listBoard when GraphQL quota is below threshold", async () => {
    quotaStatus = { available: true, remaining: 30, limit: 5000, resetAt: new Date("2026-06-16T14:23:34Z") };
    discoveredIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];
    boardItems = [{ sourceId: "9", repository: "qiaolei1973/talos-loop", boardStatus: "Ready", url: "u9", title: "T9" }];

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    expect(results[0].discovered).toEqual([]);
    expect(results[0].error).toBeUndefined();
    expect(mockUpsertIssue).not.toHaveBeenCalled();
    expect(mockSetProjectBoard).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/配额不足/));
  });

  it("falls through (still polls) when the quota probe itself fails", async () => {
    quotaStatus = { available: false, error: "network down" };
    discoveredIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];
    boardItems = [{ sourceId: "9", repository: "qiaolei1973/talos-loop", boardStatus: "Ready", url: "u9", title: "T9" }];

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    expect(results[0].discovered).toHaveLength(1);
    expect(mockUpsertIssue).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/探测失败/));
  });

  it("polls normally when quota is above threshold", async () => {
    quotaStatus = { available: true, remaining: 4000, limit: 5000 };
    discoveredIssues = [{ sourceId: "9", url: "u9", title: "T9", targetRepo: "talos-loop", state: "queued" }];
    boardItems = [{ sourceId: "9", repository: "qiaolei1973/talos-loop", boardStatus: "Ready", url: "u9", title: "T9" }];

    const { pollAll } = await import("../services/poller.js");
    const results = await pollAll();

    expect(results[0].discovered).toHaveLength(1);
    expect(mockUpsertIssue).toHaveBeenCalled();
  });
});
