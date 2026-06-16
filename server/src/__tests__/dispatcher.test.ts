import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as db from "../db/index.js";
import * as boardSnapshot from "../services/boardSnapshot.js";
import type { IssueEntry, PollResult } from "../services/poller.js";
import type { Issue } from "../db/index.js";

// --- spy references into the mocked modules ---
const mockWriteFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
const mockUpdateSessionStatus = db.updateSessionStatus as unknown as ReturnType<typeof vi.fn>;
// Issue #13: workflow status is no longer persisted — dispatch/completion/skip
// only optimistically flip the in-memory board snapshot.
const mockSetBoardStatus = boardSnapshot.setBoardStatus as unknown as ReturnType<typeof vi.fn>;

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
  capabilities: () => [
    { action: "submit-pr", description: "完成编码后提交 PR", params: [{ name: "branch", description: "" }] },
    { action: "comment", description: "在工作项留言", params: [{ name: "message", description: "" }] },
    { action: "skip", description: "放弃任务", params: [{ name: "reason", description: "" }] },
  ],
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
}));

vi.mock("../services/boardSnapshot.js", () => ({
  setBoardStatus: vi.fn(),
  setProjectBoard: vi.fn(),
  getBoardStatus: vi.fn(),
  clearBoardSnapshot: vi.fn(),
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
  exitCodePath: (session: string) => `/tmp/tl-exit-${session}.txt`,
  readExitCode: (session: string) => exitCodeBySession[session],
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
