import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueEntry, PollResult } from "../services/poller.js";
import type { Issue } from "../db/index.js";

// Per-test hook into the freshness check: maps sourceId → getStatus().state.
let statusBySourceId: Record<string, string | null> = {};
const mockPlugin = {
  name: "dima",
  async init() {},
  async discover() {
    return [];
  },
  async getStatus(_ctx: unknown, sourceId: string) {
    const state = statusBySourceId[sourceId] ?? "queued";
    return { state };
  },
  async transition() {},
  async test() {
    return true;
  },
  async onComment() {},
};

vi.mock("../config.js", () => ({
  loadConfig: () => ({ maxParallel: 1 }),
  buildSourceContextForRepo: () => ({
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repo: { name: "oceanbaseconsole-site", path: "/tmp/repo" },
  }),
}));

vi.mock("../db/index.js", () => ({
  // runningCount = 0 → slotsAvailable = maxParallel (1) for every test
  getRunningSessions: () => [],
  getRunningSessionsWithIssues: () => [],
  createSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateIssueTmux: vi.fn(),
  updateIssueStatus: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolvePlugin: async () => mockPlugin,
}));

vi.mock("../services/tmux.js", () => ({
  sessionName: (sourceName: string, _repo: string, sourceId: string) =>
    `tl-${sourceName}-oceanbaseconsole-site-${sourceId}`,
  createSession: vi.fn(),
}));

vi.mock("../services/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Stub the two filesystem writes dispatchNew performs; leave the rest of fs real.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(), chmodSync: vi.fn() };
});

function makeCandidate(sourceId: string): IssueEntry {
  const issue: Issue = {
    id: Number(sourceId),
    source_type: "@talos-loop/source-dima",
    source_id: sourceId,
    target_repo: "oceanbaseconsole-site",
    url: `https://github.com/oceanbase/console/issues/${sourceId}`,
    title: `Issue ${sourceId}`,
    tmux_session: null,
    status: "queued",
    created_at: "",
    updated_at: "",
  };
  return {
    issue,
    sourceType: "@talos-loop/source-dima",
    sourceId,
    targetRepo: "oceanbaseconsole-site",
  };
}

describe("dispatchNew slot accounting (issue #6)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    vi.clearAllMocks();
  });

  it("does not let a freshness-check skip consume a slot", async () => {
    // Two candidates; slotsAvailable = 1 (maxParallel=1, runningCount=0).
    const candidates: PollResult[] = [
      {
        sourceType: "@talos-loop/source-dima",
        discovered: [makeCandidate("1"), makeCandidate("2")],
        processing: [],
      },
    ];

    // Candidate "1" is no longer queued (e.g. label removed externally) → skipped.
    // Candidate "2" is still queued → should get the freed slot.
    statusBySourceId = { "1": null, "2": "queued" };

    const { dispatchNew } = await import("../services/dispatcher.js");
    const dispatched = await dispatchNew(candidates);

    // The bug: slice(0,1) would iterate only candidate "1", skip it, and return 0.
    expect(dispatched).toBe(1);
  });

  it("still caps at slotsAvailable when nothing is skipped", async () => {
    const candidates: PollResult[] = [
      {
        sourceType: "@talos-loop/source-dima",
        discovered: [makeCandidate("1"), makeCandidate("2"), makeCandidate("3")],
        processing: [],
      },
    ];
    statusBySourceId = { "1": "queued", "2": "queued", "3": "queued" };

    const { dispatchNew } = await import("../services/dispatcher.js");
    const dispatched = await dispatchNew(candidates);

    // Only one slot available → exactly one dispatch, not three.
    expect(dispatched).toBe(1);
  });
});
