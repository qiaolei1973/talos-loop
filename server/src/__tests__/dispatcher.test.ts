import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as db from "../db/index.js";
import * as boardSnapshot from "../services/boardSnapshot.js";
import * as worktree from "../services/worktree.js";
import type { IssueEntry, PollResult } from "../services/poller.js";
import type { Issue } from "../db/index.js";

// --- spy references into the mocked modules ---
const mockWriteFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
const mockUpdateSessionStatus = db.updateSessionStatus as unknown as ReturnType<typeof vi.fn>;
const mockCreateSession = db.createSession as unknown as ReturnType<typeof vi.fn>;
// Issue #13: workflow status is no longer persisted — dispatch/completion/skip
// only optimistically flip the in-memory board snapshot.
const mockSetBoardStatus = boardSnapshot.setBoardStatus as unknown as ReturnType<typeof vi.fn>;
// Issue #21: worktree lifecycle stubs — the dispatcher must not run real git.
const mockCreateWorktree = worktree.createWorktree as unknown as ReturnType<typeof vi.fn>;
const mockEnsureWorktree = worktree.ensureWorktree as unknown as ReturnType<typeof vi.fn>;
const mockRemoveWorktree = worktree.removeWorktree as unknown as ReturnType<typeof vi.fn>;

// --- per-test controllable state ---
// Freshness check: maps sourceId → getStatus().state.
let statusBySourceId: Record<string, string | null> = {};
// Dead sessions returned by getRunningSessionsWithIssues().
let runningSessions: any[] = [];
// tmux output per session name (error tail surfaced in the dashboard on failure).
let tmuxOutput: Record<string, string> = {};
// Sessions still alive (must be skipped by checkRunningSessions).
let tmuxAlive: Set<string> = new Set();
// Issue #20: exit code read from the launcher's sentinel file per session name.
// `undefined` (unset) models a missing sentinel (unclean termination).
let exitCodeBySession: Record<string, number | undefined> = {};
// Issue #19: review-dispatch state.
// Coding sessions with a PR that dispatchReview() inspects.
let codingSessionsWithPr: any[] = [];
// Issue ids that already have a running review session.
let runningReviewIssueIds: Set<number> = new Set();
// Board snapshot: `${projectId}/${sourceId}` → raw board column name.
let boardStatusBySourceId: Record<string, string | undefined> = {};
// Threads returned by plugin.listUnresolvedThreads() (keyed by prUrl).
let unresolvedThreadsByPr: Record<string, any[]> = {};
// dispatchReview cadence (cycles between review ticks).
let reviewDispatchEvery = 15;

const mockPlugin = {
  name: "github",
  async init() {},
  async discover() {
    return [];
  },
  async listBoard() {
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
  // Issue #19: unresolved review threads on a PR (keyed by prUrl per test).
  listUnresolvedThreads: vi.fn(async (_ctx: unknown, prUrl: string) => unresolvedThreadsByPr[prUrl] ?? []),
  capabilities: () => [
    { action: "submit-pr", description: "完成编码后提交 PR", params: [{ name: "branch", description: "" }] },
    { action: "comment", description: "在工作项留言", params: [{ name: "message", description: "" }] },
    { action: "skip", description: "放弃任务", params: [{ name: "reason", description: "" }] },
    { action: "resolve-thread", description: "解决评审线程", params: [{ name: "threadId", description: "" }, { name: "prUrl", description: "" }] },
  ],
};

vi.mock("../config.js", () => ({
  loadConfig: () => ({ maxParallel: 1, serverBaseUrl: "http://127.0.0.1:3100", reviewDispatchEvery }),
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
  getCodingSessionsWithPr: () => codingSessionsWithPr,
  getRunningReviewIssueIds: () => new Set(runningReviewIssueIds),
  createSession: vi.fn(),
  updateSessionStatus: vi.fn(),
}));

vi.mock("../services/boardSnapshot.js", () => ({
  setBoardStatus: vi.fn(),
  setProjectBoard: vi.fn(),
  getBoardStatus: (projectId: string, sourceId: string) => boardStatusBySourceId[`${projectId}/${sourceId}`],
  clearBoardSnapshot: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolvePlugin: async () => mockPlugin,
}));

vi.mock("../services/tmux.js", () => ({
  sessionName: (sourceName: string, repo: string, sourceId: string) =>
    `tl-${sourceName}-${repo}-${sourceId}`,
  reviewSessionName: (sourceName: string, repo: string, sourceId: string) =>
    `tl-${sourceName}-${repo}-${sourceId}-review`,
  createSession: vi.fn(),
  captureOutput: (session: string) => tmuxOutput[session] ?? "",
  isAlive: (session: string) => tmuxAlive.has(session),
  exitCodePath: (session: string) => `/tmp/tl-exit-${session}.txt`,
  readExitCode: (session: string) => exitCodeBySession[session],
}));

// Issue #21: stub the worktree service so dispatch never runs real git. The
// deterministic path helper is kept real (a pure string) so dispatch/retry can
// be asserted on; create/ensure/remove are vi.fns (referenced via the import
// above, like the db/boardSnapshot mocks).
vi.mock("../services/worktree.js", () => ({
  worktreePath: (repoPath: string, session: string) => `/tmp/talos-worktrees/${session}`,
  createWorktree: vi.fn(),
  ensureWorktree: vi.fn(),
  removeWorktree: vi.fn(),
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
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: sourceId,
    target_repo: "talos-loop",
    url: `https://github.com/qiaolei1973/talos-loop/issues/${sourceId}`,
    title: `Issue ${sourceId}`,
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

/**
 * A dead running session for issue #9. Issue #20: the done/failed split is now
 * driven by the exit-code sentinel (exitCodeBySession), NOT by `prUrl` alone —
 * `prUrl` only decides whether a clean exit advances the board.
 */
function makeRunningSession(session: string, sourceId = "9", prUrl: string | null = null): any {
  return {
    id: 100,
    tmux_session: session,
    pr_url: prUrl,
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
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
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

describe("buildPrompt percent-encodes projectId and renders capabilities", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  it("encodes \"owner/number\" in the actions base URL and lists the plugin capabilities", async () => {
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

    // projectId "qiaolei1973/1" → must appear percent-encoded in the actions URL.
    expect(prompt).toContain("/api/projects/qiaolei1973%2F1/issues/1/actions");
    // …and the raw slash form must NOT appear in the talos-loop API path.
    expect(prompt).not.toMatch(/\/api\/projects\/qiaolei1973\/1\/issues/);
    // The plugin's declared capabilities are rendered as the action block.
    expect(prompt).toContain("- submit-pr：");
    expect(prompt).toContain("- comment：");
    expect(prompt).toContain("- skip：");
    // The old per-action routes and the single-line PR-URL instruction are gone.
    expect(prompt).not.toMatch(/\/issues\/\d+\/(skip|comment)\b/);
    expect(prompt).not.toMatch(/单独一行输出 PR/);
    // Issue #13: a successful dispatch optimistically flips the snapshot to
    // "In progress" instead of writing a persisted status column.
    expect(mockSetBoardStatus).toHaveBeenCalledWith("qiaolei1973/1", "1", "In progress");
  });
});

describe("launcher script writes the exit-code sentinel (issue #20)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  it("echoes $? to the sentinel path right after the agent exits", async () => {
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

    // Find the launcher-script write (the writeFileSync whose path ends in .sh).
    const scriptCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".sh"),
    );
    expect(scriptCall, "launcher script should have been written").toBeDefined();
    const script = String((scriptCall as any[])[1]);

    // The session name for github:talos-loop:1 → the sentinel path the reader expects.
    const session = "tl-github-talos-loop-1";
    // `$?` is captured immediately after `claude` so it reflects the agent's exit.
    expect(script).toContain(`echo $? > "/tmp/tl-exit-${session}.txt"`);
    // The sentinel write must come AFTER the claude invocation and BEFORE cleanup.
    const claudeLine = script.indexOf("claude ");
    const echoLine = script.indexOf("echo $?");
    const rmLine = script.indexOf("rm -f");
    expect(claudeLine).toBeGreaterThanOrEqual(0);
    expect(echoLine).toBeGreaterThan(claudeLine);
    expect(rmLine).toBeGreaterThan(echoLine);
  });
});

describe("checkRunningSessions classifies by exit code, not task outcome (issue #20)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  // (a) exit 0 + pr_url → session done, board advances (the ONLY board move).
  it("exit 0 + pr_url → done, transition done, comment PR, board → In review", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 0; // clean exit
    runningSessions = [makeRunningSession(session, "9", "https://github.com/qiaolei1973/talos-loop/pull/42")];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 1, failed: 0 });

    // session finalized as done with the stored PR url
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "done", "https://github.com/qiaolei1973/talos-loop/pull/42");
    // board transition processing → done
    expect(mockPlugin.transition).toHaveBeenCalledWith(
      expect.anything(), "9", { from: "processing", to: "done" }, "talos-loop",
    );
    // PR comment posted
    expect(mockPlugin.onComment).toHaveBeenCalledTimes(1);
    expect(String((mockPlugin.onComment as any).mock.calls[0][2])).toContain("pull/42");
    // completion optimistically mirrors the board move (processing → "In review").
    expect(mockSetBoardStatus).toHaveBeenCalledWith("qiaolei1973/1", "9", "In review");
  });

  // (b) exit 0 + no pr_url → done, board UNCHANGED (e.g. a review session).
  it("exit 0 + no pr_url → done, NO transition, NO comment, board untouched", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 0; // clean exit, but the agent never submitted a PR
    runningSessions = [makeRunningSession(session, "9", null)];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 1, failed: 0 });

    // session finalized as done with no PR url and no error
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "done", undefined);
    // board is NOT advanced — only an explicit submit-pr/skip action moves it
    expect(mockPlugin.transition).not.toHaveBeenCalled();
    expect(mockPlugin.onComment).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  // (c) non-zero exit → failed, board UNCHANGED.
  it("non-zero exit → failed+tail, NO transition, NO comment, board untouched", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 1; // crashed
    runningSessions = [makeRunningSession(session, "9", null)];
    // The error tail is captured from tmux output (now genuinely error output,
    // because failed only fires on a real crash — issue #20, user story 3).
    tmuxOutput[session] = "Error: rate limit exceeded, please retry";

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1 });

    // session failed with the error tail (silent — dashboard only)
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      100, "failed", undefined, expect.stringContaining("rate limit exceeded"),
    );
    // board is intentionally left "In progress" — NOT rolled back to Ready
    expect(mockPlugin.transition).not.toHaveBeenCalled();
    expect(mockPlugin.onComment).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  // (d) sentinel absent → failed (unclean termination), board UNCHANGED.
  it("missing sentinel → failed+unclean message, NO transition, board untouched", async () => {
    const session = "tl-github-talos-loop-9";
    // exitCodeBySession[session] deliberately unset → readExitCode returns undefined
    runningSessions = [makeRunningSession(session, "9", null)];
    // No captured output either (e.g. killed externally) → falls back to the reason.
    tmuxOutput[session] = "";

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1 });

    // session failed with the unclean-termination message (no exit code to report)
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      100, "failed", undefined, expect.stringContaining("no exit-code sentinel"),
    );
    // board left "In progress" for investigation — NOT rolled back to Ready
    expect(mockPlugin.transition).not.toHaveBeenCalled();
    expect(mockPlugin.onComment).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  it("alive sessions are left alone", async () => {
    const session = "tl-github-talos-loop-9";
    runningSessions = [makeRunningSession(session, "9", null)];
    tmuxAlive = new Set([session]); // still running

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 0 });
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
    expect(mockPlugin.transition).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Issue #19: PR review auto-fix
// ---------------------------------------------------------------------------

/** A coding session that has created a PR (a dispatchReview candidate). */
function makeCodingSessionWithPr(
  sourceId: string,
  overrides: Partial<{ id: number; issue_id: number; pr_url: string; branch: string }> = {},
): any {
  return {
    id: 200,
    issue_id: Number(sourceId),
    tmux_session: `tl-github-talos-loop-${sourceId}`,
    status: "done",
    pr_url: `https://github.com/qiaolei1973/talos-loop/pull/${sourceId}`,
    branch: `feat/${sourceId}`,
    type: "coding",
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: sourceId,
    target_repo: "talos-loop",
    ...overrides,
  };
}

describe("dispatchReview() (issue #19)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  // (a) dispatches when unresolved threads present and no running review session.
  it("dispatches a review session when unresolved threads exist", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: "feat/9" })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "In review"; // still In review
    unresolvedThreadsByPr[PR] = [
      { id: "PRRT_1", body: "fix this", path: "a.ts", resolved: false },
      { id: "PRRT_2", body: "and this", path: "b.ts", resolved: false },
    ];

    const { dispatchReview } = await import("../services/dispatcher.js");
    const reviewed = await dispatchReview();

    expect(reviewed).toBe(1);
    // listUnresolvedThreads was probed for the PR.
    expect(mockPlugin.listUnresolvedThreads).toHaveBeenCalledWith(expect.anything(), PR);
    // A review session was created on a worktree, recording the PR url + branch up front.
    expect(mockCreateSession).toHaveBeenCalledWith(
      9,
      "tl-github-talos-loop-9-review",
      { type: "review", branch: "feat/9", prUrl: PR },
    );
  });

  // (b) skips when a review session is already running for the issue.
  it("skips when a review session is already running for the issue", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: "feat/9" })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "In review";
    unresolvedThreadsByPr[PR] = [{ id: "PRRT_1", body: "x", resolved: false }];
    runningReviewIssueIds = new Set([9]); // a review session is already running

    const { dispatchReview } = await import("../services/dispatcher.js");
    const reviewed = await dispatchReview();

    expect(reviewed).toBe(0);
    expect(mockCreateSession).not.toHaveBeenCalled();
    // The probe short-circuits before even asking for threads.
    expect(mockPlugin.listUnresolvedThreads).not.toHaveBeenCalled();
  });

  // (c) skips when all threads resolved (no unresolved threads).
  it("skips when there are no unresolved threads", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: "feat/9" })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "In review";
    unresolvedThreadsByPr[PR] = []; // all resolved

    const { dispatchReview } = await import("../services/dispatcher.js");
    const reviewed = await dispatchReview();

    expect(reviewed).toBe(0);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("skips when the board is no longer In review (e.g. merged → Done)", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: "feat/9" })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "Done"; // merged — no review work
    unresolvedThreadsByPr[PR] = [{ id: "PRRT_1", body: "x", resolved: false }];

    const { dispatchReview } = await import("../services/dispatcher.js");
    const reviewed = await dispatchReview();

    expect(reviewed).toBe(0);
    expect(mockPlugin.listUnresolvedThreads).not.toHaveBeenCalled();
  });

  it("skips when the coding session recorded no branch to push to", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: null as unknown as string })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "In review";

    const { dispatchReview } = await import("../services/dispatcher.js");
    const reviewed = await dispatchReview();

    expect(reviewed).toBe(0);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("writes a review-specific prompt that instructs the within-session loop", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: "feat/9" })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "In review";
    unresolvedThreadsByPr[PR] = [{ id: "PRRT_1", body: "x", resolved: false }];

    const { dispatchReview } = await import("../services/dispatcher.js");
    await dispatchReview();

    // The review prompt is the .txt write; it must name the PR + branch + the
    // resolve-thread action and the re-check loop, but must NOT mention submit-pr
    // as the goal (review never opens a new PR).
    const promptCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".txt"),
    );
    expect(promptCall, "review prompt file should have been written").toBeDefined();
    const prompt = String((promptCall as any[])[1]);
    expect(prompt).toContain(PR);
    expect(prompt).toContain("feat/9");
    expect(prompt).toContain("resolve-thread");
    expect(prompt).toContain("git worktree");
    expect(prompt).toMatch(/重新获取评审线程|未解决/i); // the re-check loop instruction
  });
});

describe("checkRunningSessions() review branch (issue #19)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  it("clean review exit → done, NO transition, NO comment, board untouched", async () => {
    const session = "tl-github-talos-loop-9-review";
    exitCodeBySession[session] = 0;
    // A review session carries a pr_url (written at dispatch) but must NOT take
    // the coding success-path that keys off pr_url.
    runningSessions = [
      {
        id: 300,
        tmux_session: session,
        pr_url: "https://github.com/qiaolei1973/talos-loop/pull/42",
        type: "review",
        branch: "feat/9",
        project_id: "qiaolei1973/1",
        project_type: "github",
        source_id: "9",
        target_repo: "talos-loop",
      },
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 1, failed: 0 });
    // done with the stored pr_url, but…
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(300, "done", "https://github.com/qiaolei1973/talos-loop/pull/42");
    // …NO board transition, NO completion comment, NO optimistic board flip.
    expect(mockPlugin.transition).not.toHaveBeenCalled();
    expect(mockPlugin.onComment).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  it("crashed review exit → failed, board untouched (implicit retry next tick)", async () => {
    const session = "tl-github-talos-loop-9-review";
    exitCodeBySession[session] = 1;
    tmuxOutput[session] = "Error: something blew up";
    runningSessions = [
      {
        id: 300,
        tmux_session: session,
        pr_url: "https://github.com/qiaolei1973/talos-loop/pull/42",
        type: "review",
        branch: "feat/9",
        project_id: "qiaolei1973/1",
        project_type: "github",
        source_id: "9",
        target_repo: "talos-loop",
      },
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      300, "failed", undefined, expect.stringContaining("blew up"),
    );
    expect(mockPlugin.transition).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });
});

describe("dispatch() gates review on a slow counter (issue #19)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    // Fire review every 2 cycles so we can observe gating in few iterations.
    reviewDispatchEvery = 2;
    vi.clearAllMocks();
  });

  // (d) fires on every Nth dispatch cycle, not every cycle.
  it("dispatches review only on every Nth cycle", async () => {
    const PR = "https://github.com/qiaolei1973/talos-loop/pull/9";
    codingSessionsWithPr = [makeCodingSessionWithPr("9", { pr_url: PR, branch: "feat/9" })];
    boardStatusBySourceId["qiaolei1973/1/9"] = "In review";
    unresolvedThreadsByPr[PR] = [{ id: "PRRT_1", body: "x", resolved: false }];

    const mod = await import("../services/dispatcher.js");
    (mod as any).resetReviewTick();

    // Cycle 1: NOT a review tick → no review session.
    await mod.dispatch([]);
    expect(mockCreateSession).not.toHaveBeenCalled();

    // Cycle 2: review tick → exactly one review session.
    await mod.dispatch([]);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);

    // Cycle 3: not a tick again.
    await mod.dispatch([]);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);

    // Cycle 4: tick again → a second review session (threads still unresolved).
    await mod.dispatch([]);
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Issue #21: retry a failed session in place (preserved worktree + branch)
// ---------------------------------------------------------------------------

const WT = "/tmp/talos-worktrees/tl-github-talos-loop-9";
const BRANCH = "feat/issue-9";

/** A failed coding session with a preserved worktree — what getRetryableSession
 *  returns and dispatchRetry receives. */
function makeFailedRetryableSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 500,
    issue_id: 9,
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: "9",
    target_repo: "talos-loop",
    url: "https://github.com/qiaolei1973/talos-loop/issues/9",
    worktree_path: WT,
    branch: BRANCH,
    status: "failed",
    type: "coding",
    ...overrides,
  };
}

describe("dispatchRetry() reuses the failed session's worktree + branch (issue #21)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  it("dispatches a new coding session into the PRESERVED worktree (no fresh create)", async () => {
    const { dispatchRetry } = await import("../services/dispatcher.js");
    await dispatchRetry(makeFailedRetryableSession());

    // ensureWorktree reuses the existing worktree; createWorktree is NOT used.
    expect(mockEnsureWorktree).toHaveBeenCalledWith("/tmp/talos-loop", WT, BRANCH);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    // New coding session inherits issue_id, branch, AND worktree_path.
    expect(mockCreateSession).toHaveBeenCalledWith(9, "tl-github-talos-loop-9", {
      type: "coding",
      branch: BRANCH,
      worktreePath: WT,
    });
  });

  it("launches the agent INSIDE the existing worktree", async () => {
    const { dispatchRetry } = await import("../services/dispatcher.js");
    await dispatchRetry(makeFailedRetryableSession());

    const scriptCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".sh"),
    );
    expect(scriptCall, "launcher script should have been written").toBeDefined();
    expect(String((scriptCall as any[])[1])).toContain(`cd ${WT}`);
  });

  it("writes a retry prompt that says continue, references the worktree + branch", async () => {
    const { dispatchRetry } = await import("../services/dispatcher.js");
    await dispatchRetry(makeFailedRetryableSession());

    const promptCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".txt"),
    );
    expect(promptCall, "retry prompt file should have been written").toBeDefined();
    const prompt = String((promptCall as any[])[1]);

    // The retry prompt names the existing environment.
    expect(prompt).toContain(WT);
    expect(prompt).toContain(BRANCH);
    expect(prompt).toContain("https://github.com/qiaolei1973/talos-loop/issues/9");
    // …tells the agent to continue, not start over…
    expect(prompt).toMatch(/继续|当前状态/);
    // …and is NOT the initial-dispatch prompt (which opens with "实现以下 Issue").
    expect(prompt).not.toMatch(/请实现以下 Issue/);
  });

  it("does not touch the board (no transition, no board snapshot flip)", async () => {
    const { dispatchRetry } = await import("../services/dispatcher.js");
    await dispatchRetry(makeFailedRetryableSession());

    expect(mockPlugin.transition).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });
});

describe("checkRunningSessions() worktree lifecycle (issue #21)", () => {
  beforeEach(() => {
    statusBySourceId = {};
    runningSessions = [];
    tmuxOutput = {};
    tmuxAlive = new Set();
    exitCodeBySession = {};
    codingSessionsWithPr = [];
    runningReviewIssueIds = new Set();
    boardStatusBySourceId = {};
    unresolvedThreadsByPr = {};
    reviewDispatchEvery = 15;
    vi.clearAllMocks();
  });

  it("on failure, does NOT remove the worktree (preserved for retry)", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 1; // crashed
    tmuxOutput[session] = "Error: rate limit exceeded";
    runningSessions = [{
      id: 100,
      tmux_session: session,
      pr_url: null,
      type: "coding",
      worktree_path: WT,
      branch: BRANCH,
      project_id: "qiaolei1973/1",
      project_type: "github",
      source_id: "9",
      target_repo: "talos-loop",
    }];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1 });
    // The worktree stays on disk — no cleanup on the failure path.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it("on success (exit 0 + pr_url), removes the worktree as a safety net", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 0; // clean exit
    runningSessions = [{
      id: 100,
      tmux_session: session,
      pr_url: "https://github.com/qiaolei1973/talos-loop/pull/42",
      type: "coding",
      worktree_path: WT,
      branch: BRANCH,
      project_id: "qiaolei1973/1",
      project_type: "github",
      source_id: "9",
      target_repo: "talos-loop",
    }];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    await checkRunningSessions();

    // Success path safety-net removes the worktree (issue #21).
    expect(mockRemoveWorktree).toHaveBeenCalledWith("/tmp/talos-loop", WT);
  });
});

