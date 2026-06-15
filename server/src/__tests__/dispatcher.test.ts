import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as db from "../db/index.js";
import type { IssueEntry, PollResult } from "../services/poller.js";
import type { Issue } from "../db/index.js";

// --- spy references into the mocked modules ---
const mockWriteFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
const mockUpdateSessionStatus = db.updateSessionStatus as unknown as ReturnType<typeof vi.fn>;
const mockUpdateIssueStatus = db.updateIssueStatus as unknown as ReturnType<typeof vi.fn>;
const mockUpdateIssueTmux = db.updateIssueTmux as unknown as ReturnType<typeof vi.fn>;

// --- per-test controllable state ---
// Freshness check: maps sourceId → getStatus().state.
let statusBySourceId: Record<string, string | null> = {};
// Dead sessions returned by getRunningSessionsWithIssues().
let runningSessions: any[] = [];
// tmux output per session name (PR-found vs infra-failure signal).
let tmuxOutput: Record<string, string> = {};
// Sessions still alive (must be skipped by checkRunningSessions).
let tmuxAlive: Set<string> = new Set();

const mockPlugin = {
  name: "github",
  async init() {},
  async discover() {
    return [];
  },
  async getStatus(_ctx: unknown, sourceId: string, _targetRepo: string) {
    const state = statusBySourceId[sourceId] ?? "queued";
    return { state };
  },
  transition: vi.fn(),
  async test() {
    return true;
  },
  onComment: vi.fn(),
  async skip() {},
};

vi.mock("../config.js", () => ({
  loadConfig: () => ({ maxParallel: 1, serverBaseUrl: "http://127.0.0.1:3100" }),
  buildProjectContextForIssue: () => ({
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repos: [{ name: "talos-loop", path: "/tmp/talos-loop", remote: "qiaolei1973/talos-loop" }],
    projectId: "qiaolei1973/1",
  }),
}));

vi.mock("../db/index.js", () => ({
  // runningCount = 0 → slotsAvailable = maxParallel (1) for every test
  getRunningSessions: () => [],
  getRunningSessionsWithIssues: () => runningSessions,
  createSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateIssueTmux: vi.fn(),
  updateIssueStatus: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolvePlugin: async () => mockPlugin,
}));

vi.mock("../services/tmux.js", () => ({
  sessionName: (sourceName: string, repo: string, sourceId: string) =>
    `tl-${sourceName}-${repo}-${sourceId}`,
  createSession: vi.fn(),
  captureOutput: (session: string) => tmuxOutput[session] ?? "",
  isAlive: (session: string) => tmuxAlive.has(session),
}));

vi.mock("../services/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// findPrUrl (infra-failure fallback) shells out via execSync. Default to "" so
// it resolves to null — the PR-found branch supplies its URL via tmux output.
vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

// Stub the two filesystem writes dispatchNew performs; leave the rest of fs real.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(), chmodSync: vi.fn() };
});

function makeCandidate(sourceId: string): IssueEntry {
  const issue: Issue = {
    id: Number(sourceId),
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: sourceId,
    target_repo: "talos-loop",
    url: `https://github.com/qiaolei1973/talos-loop/issues/${sourceId}`,
    title: `Issue ${sourceId}`,
    tmux_session: null,
    status: "queued",
    created_at: "",
    updated_at: "",
  };
  return {
    issue,
    projectId: "qiaolei1973/1",
    projectType: "github",
    sourceId,
    targetRepo: "talos-loop",
  };
}

/** A dead running session for issue #9. */
function makeRunningSession(session: string, sourceId = "9"): any {
  return {
    id: 100,
    tmux_session: session,
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: sourceId,
    target_repo: "talos-loop",
  };
}

describe("dispatchNew slot accounting (issue #6)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    vi.clearAllMocks();
  });

  it("does not let a freshness-check skip consume a slot", async () => {
    // Two candidates; slotsAvailable = 1 (maxParallel=1, runningCount=0).
    const candidates: PollResult[] = [
      {
        projectId: "qiaolei1973/1",
        projectType: "github",
        discovered: [makeCandidate("1"), makeCandidate("2")],
      },
    ];

    // Candidate "1" is no longer queued (e.g. board moved externally) → skipped.
    // Candidate "2" is still queued → should get the freed slot.
    statusBySourceId = { "1": null, "2": "queued" };

    const { dispatchNew } = await import("../services/dispatcher.js");
    const dispatched = await dispatchNew(candidates);

    expect(dispatched).toBe(1);
  });

  it("still caps at slotsAvailable when nothing is skipped", async () => {
    const candidates: PollResult[] = [
      {
        projectId: "qiaolei1973/1",
        projectType: "github",
        discovered: [makeCandidate("1"), makeCandidate("2"), makeCandidate("3")],
      },
    ];
    statusBySourceId = { "1": "queued", "2": "queued", "3": "queued" };

    const { dispatchNew } = await import("../services/dispatcher.js");
    const dispatched = await dispatchNew(candidates);

    // Only one slot available → exactly one dispatch, not three.
    expect(dispatched).toBe(1);
  });
});

describe("buildPrompt percent-encodes the slash in projectId", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    vi.clearAllMocks();
  });

  it("encodes \"owner/number\" so the skip/comment route URLs are valid", async () => {
    statusBySourceId = { "1": "queued" };
    const candidates: PollResult[] = [
      {
        projectId: "qiaolei1973/1",
        projectType: "github",
        discovered: [makeCandidate("1")],
      },
    ];

    const { dispatchNew } = await import("../services/dispatcher.js");
    await dispatchNew(candidates);

    // Find the prompt-file write (the only writeFileSync whose path ends in .txt).
    const promptCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".txt"),
    );
    expect(promptCall, "prompt file should have been written").toBeDefined();
    const prompt = String((promptCall as any[])[1]);

    // projectId "qiaolei1973/1" → must appear percent-encoded in the URLs.
    expect(prompt).toContain("/api/projects/qiaolei1973%2F1/issues/1/skip");
    expect(prompt).toContain("/api/projects/qiaolei1973%2F1/issues/1/comment");
    // …and the raw slash form must NOT appear in the talos-loop API path.
    expect(prompt).not.toMatch(/\/api\/projects\/qiaolei1973\/1\/issues/);
  });
});

describe("checkRunningSessions dual-failure-path (issue #9)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    vi.clearAllMocks();
  });

  it("PR found → transition done, comment PR, session done, issue done", async () => {
    const session = "tl-github-talos-loop-9";
    runningSessions = [makeRunningSession(session)];
    tmuxOutput[session] = "Created https://github.com/qiaolei1973/talos-loop/pull/42";

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 1, failed: 0 });

    // session finalized as done with the PR url
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "done", "https://github.com/qiaolei1973/talos-loop/pull/42");
    // issue → done (semantics: In review)
    expect(mockUpdateIssueStatus).toHaveBeenCalledWith("qiaolei1973/1", "9", "done");
    // board transition processing → done
    expect(mockPlugin.transition).toHaveBeenCalledWith(
      expect.anything(), "9", { from: "processing", to: "done" }, "talos-loop",
    );
    // PR comment posted
    expect(mockPlugin.onComment).toHaveBeenCalledTimes(1);
    expect(String((mockPlugin.onComment as any).mock.calls[0][2])).toContain("pull/42");
    // tmux pointer cleared
    expect(mockUpdateIssueTmux).toHaveBeenCalledWith("qiaolei1973/1", "9", null);
  });

  it("infra failure → transition queued, NO comment, session failed+tail, issue queued", async () => {
    const session = "tl-github-talos-loop-9";
    runningSessions = [makeRunningSession(session)];
    tmuxOutput[session] = "Error: rate limit exceeded, please retry"; // no PR url

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1 });

    // session failed with the error tail (silent — dashboard only)
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      100, "failed", undefined, expect.stringContaining("rate limit exceeded"),
    );
    // issue → queued (back to Ready for auto-retry)
    expect(mockUpdateIssueStatus).toHaveBeenCalledWith("qiaolei1973/1", "9", "queued");
    // board transition processing → queued (back to Ready)
    expect(mockPlugin.transition).toHaveBeenCalledWith(
      expect.anything(), "9", { from: "processing", to: "queued" }, "talos-loop",
    );
    // NO comment posted (silent infra failure)
    expect(mockPlugin.onComment).not.toHaveBeenCalled();
    expect(mockUpdateIssueTmux).toHaveBeenCalledWith("qiaolei1973/1", "9", null);
  });

  it("alive sessions are left alone", async () => {
    const session = "tl-github-talos-loop-9";
    runningSessions = [makeRunningSession(session)];
    tmuxAlive = new Set([session]); // still running

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 0 });
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
    expect(mockPlugin.transition).not.toHaveBeenCalled();
  });
});
