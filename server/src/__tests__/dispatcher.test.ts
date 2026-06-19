import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as db from "../db/index.js";
import * as boardSnapshot from "../services/boardSnapshot.js";
import * as worktree from "../services/worktree.js";
import * as tmux from "../services/tmux.js";
import type { IssueEntry, PollResult } from "../services/poller.js";
import type { Issue } from "../db/index.js";

// --- spy references into the mocked modules ---
const mockWriteFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
const mockUpdateSessionStatus = db.updateSessionStatus as unknown as ReturnType<typeof vi.fn>;
const mockCreateSession = db.createSession as unknown as ReturnType<typeof vi.fn>;
const mockSetSessionClaudeId = db.setSessionClaudeId as unknown as ReturnType<typeof vi.fn>;
const mockGetIssue = db.getIssue as unknown as ReturnType<typeof vi.fn>;
const mockSetBoardStatus = boardSnapshot.setBoardStatus as unknown as ReturnType<typeof vi.fn>;
const mockCreateWorktree = worktree.createWorktree as unknown as ReturnType<typeof vi.fn>;
const mockEnsureWorktree = worktree.ensureWorktree as unknown as ReturnType<typeof vi.fn>;
const mockRemoveWorktree = worktree.removeWorktree as unknown as ReturnType<typeof vi.fn>;
const mockKillSession = tmux.killSession as unknown as ReturnType<typeof vi.fn>;
const mockCreateTmuxSession = tmux.createSession as unknown as ReturnType<typeof vi.fn>;

// --- per-test controllable state ---
// Freshness check: maps sourceId → getItem().state.
let statusBySourceId: Record<string, string | null> = {};
// Dead sessions returned by getRunningSessionsWithIssues().
let runningSessions: any[] = [];
// tmux output per session name (error tail surfaced on failure).
let tmuxOutput: Record<string, string> = {};
// Sessions still alive (must be skipped by checkRunningSessions).
let tmuxAlive: Set<string> = new Set();
// Exit code read from the launcher's sentinel per session name (undefined = missing).
let exitCodeBySession: Record<string, number | undefined> = {};
// Captured claude session id read from the formatter's sidecar per session name.
let readSessionIdBySession: Record<string, string | undefined> = {};
// Wall-clock watchdog limit (seconds). Defaults huge so most tests are unaffected.
let claudeTimeout = 99_999;
let maxRetry = 1;
let keepSessionOnSuccess = false;
// Issue ids that already have a running review session.
let runningReviewIssueIds: Set<number> = new Set();
// The per-project stage→skill map. Default configures both core stages.
let stages: Record<string, string> = { ready: "github-code", "in-review": "github-review" };
// Repos injected into ProjectContext (mutable so a test can declare a baseline branch).
function defaultCtxRepos() {
  return [{ name: "talos-loop", path: "/tmp/talos-loop", remote: "qiaolei1973/talos-loop" }];
}
let ctxRepos = defaultCtxRepos();

const mockPlugin = {
  name: "github",
  writeLabel: vi.fn(),
  async getItem(_ctx: unknown, sourceId: string, _targetRepo: string) {
    // An explicit null means "not actionable"; an unset key defaults to queued.
    const s = statusBySourceId[sourceId];
    return { state: s === undefined ? "queued" : s };
  },
  writeComment: vi.fn(),
};

vi.mock("../config.js", () => ({
  loadConfig: () => ({ maxParallel: 1, maxRetry, keepSessionOnSuccess, claudeTimeout }),
  buildProjectContextForIssue: () => ({
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repos: ctxRepos,
    projectId: "qiaolei1973/1",
  }),
  getProjectById: () => ({ stages }),
}));

vi.mock("../db/index.js", () => ({
  getRunningSessions: () => [],
  getRunningSessionsWithIssues: () => runningSessions,
  getRunningReviewIssueIds: () => new Set(runningReviewIssueIds),
  createSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  setSessionClaudeId: vi.fn(),
  getIssue: vi.fn(),
}));

vi.mock("../services/boardSnapshot.js", () => ({
  setBoardStatus: vi.fn(),
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
  sessionIdPath: (session: string) => `/tmp/tl-session-${session}.txt`,
  readSessionId: (session: string) => readSessionIdBySession[session],
  // A real kill detaches the session; mirror that so a watchdog-killed session
  // reads as dead and falls through to classification.
  killSession: vi.fn((session: string) => {
    tmuxAlive.delete(session);
  }),
}));

vi.mock("../services/worktree.js", () => ({
  worktreePath: (repoPath: string, session: string) => `/tmp/talos-worktrees/${session}`,
  createWorktree: vi.fn(),
  ensureWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("../services/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Stub the launcher-script + chmod writes; leave the rest of fs real.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(), chmodSync: vi.fn() };
});

function makeIssue(sourceId: string): Issue {
  return {
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
}

/** A poll candidate carrying the standard state (+ optional subIssues) the poller now emits. */
function makeCandidate(
  sourceId: string,
  state: "queued" | "processing" | "done" = "queued",
  subIssues?: any[],
): IssueEntry {
  return {
    issue: makeIssue(sourceId),
    projectId: "qiaolei1973/1",
    projectType: "github",
    sourceId,
    targetRepo: "talos-loop",
    state,
    subIssues,
  };
}

/** A dead running session row joined with its issue fields. */
function makeRunningSession(
  session: string,
  overrides: Record<string, unknown> = {},
): any {
  const sourceId = (overrides.source_id as string) ?? "9";
  return {
    id: 100,
    tmux_session: session,
    status: "running",
    type: "coding",
    retry_count: 0,
    claude_session_id: null,
    started_at: null as string | null,
    worktree_path: null as string | null,
    branch: null as string | null,
    issue_id: Number(sourceId),
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: sourceId,
    target_repo: "talos-loop",
    ...overrides,
  };
}

/** The single launcher-script write dispatch performs. */
function launcherScript(): string {
  const scriptCall = mockWriteFileSync.mock.calls.find(
    (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".sh"),
  );
  if (!scriptCall) throw new Error("launcher script was not written");
  return String((scriptCall as any[])[1]);
}

const baseReset = () => {
  statusBySourceId = {};
  runningSessions = [];
  tmuxOutput = {};
  tmuxAlive = new Set();
  exitCodeBySession = {};
  readSessionIdBySession = {};
  claudeTimeout = 99_999;
  maxRetry = 1;
  keepSessionOnSuccess = false;
  runningReviewIssueIds = new Set();
  stages = { ready: "github-code", "in-review": "github-review" };
  ctxRepos = defaultCtxRepos();
  vi.clearAllMocks();
  mockGetIssue.mockImplementation((_pid: string, sid: string) => makeIssue(sid));
};

// ---------------------------------------------------------------------------
// dispatchNew: a queued issue → worktree + writeLabel + skill launch + session
// ---------------------------------------------------------------------------

describe("dispatchNew() launches the ready-stage skill (issue #32)", () => {
  beforeEach(baseReset);

  it("creates a worktree, advances queued→processing, and launches the skill", async () => {
    statusBySourceId = { "1": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("1")] },
    ];

    const { dispatchNew } = await import("../services/dispatcher.js");
    const dispatched = await dispatchNew(candidates);

    expect(dispatched).toBe(1);
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      "/tmp/talos-loop",
      "/tmp/talos-worktrees/tl-github-talos-loop-1",
      "feat/issue-1",
      "main",
    );
    expect(mockPlugin.writeLabel).toHaveBeenCalledWith(
      expect.anything(), "1", { from: "queued", to: "processing" }, "talos-loop",
    );
    expect(mockCreateSession).toHaveBeenCalledWith(1, "tl-github-talos-loop-1", {
      type: "coding",
      branch: "feat/issue-1",
      worktreePath: "/tmp/talos-worktrees/tl-github-talos-loop-1",
    });
    // Issue #32: the snapshot is flipped to the STANDARD state "processing".
    expect(mockSetBoardStatus).toHaveBeenCalledWith("qiaolei1973/1", "1", "processing");
    expect(mockCreateTmuxSession).toHaveBeenCalledTimes(1);
  });

  it("invokes the skill by name in -p print + stream-json mode (no prompt file)", async () => {
    statusBySourceId = { "1": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("1")] },
    ];
    const { dispatchNew } = await import("../services/dispatcher.js");
    await dispatchNew(candidates);

    const script = launcherScript();
    // The self-contained skill is invoked by name with the issue URL.
    expect(script).toContain(`claude -p "/github-code 处理 issue：https://github.com/qiaolei1973/talos-loop/issues/1"`);
    expect(script).toContain("--dangerously-skip-permissions");
    expect(script).toContain("--output-format=stream-json");
    expect(script).toContain("--verbose");
    // Context is injected via env vars, not baked into a prompt.
    expect(script).toContain('export TALOS_ISSUE_URL="https://github.com/qiaolei1973/talos-loop/issues/1"');
    expect(script).toContain('export TALOS_BRANCH="feat/issue-1"');
    expect(script).toContain('export TALOS_TARGET_REPO="talos-loop"');
    // No prompt .txt is written anymore — only the launcher script.
    const txtCalls = mockWriteFileSync.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".txt"),
    );
    expect(txtCalls).toHaveLength(0);
  });

  it("exits with PIPESTATUS[0] (claude's exit) into the sentinel, no pipefail (issue #30)", async () => {
    statusBySourceId = { "1": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("1")] },
    ];
    const { dispatchNew } = await import("../services/dispatcher.js");
    await dispatchNew(candidates);

    const session = "tl-github-talos-loop-1";
    const script = launcherScript();
    expect(script).toContain(`echo \${PIPESTATUS[0]} > "/tmp/tl-exit-${session}.txt"`);
    expect(script).not.toMatch(/echo \$\? >/);
    expect(script).not.toContain("pipefail");
  });

  it("a freshness-check skip does not consume a slot", async () => {
    statusBySourceId = { "1": null, "2": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("1"), makeCandidate("2")] },
    ];
    const { dispatchNew } = await import("../services/dispatcher.js");
    expect(await dispatchNew(candidates)).toBe(1);
    // Only candidate "2" was dispatched.
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockCreateWorktree.mock.calls[0][2]).toBe("feat/issue-2");
  });

  it("caps at slotsAvailable when nothing is skipped", async () => {
    statusBySourceId = { "1": "queued", "2": "queued", "3": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("1"), makeCandidate("2"), makeCandidate("3")] },
    ];
    const { dispatchNew } = await import("../services/dispatcher.js");
    expect(await dispatchNew(candidates)).toBe(1);
  });

  it("skips (no dispatch) when no 'ready' stage skill is configured", async () => {
    stages = {}; // no ready skill
    statusBySourceId = { "1": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("1")] },
    ];
    const { dispatchNew } = await import("../services/dispatcher.js");
    expect(await dispatchNew(candidates)).toBe(0);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it("cuts the feat branch from the repo's configured baseline (issue #28)", async () => {
    ctxRepos = [{ name: "talos-loop", path: "/tmp/talos-loop", remote: "qiaolei1973/talos-loop", branch: "develop" }];
    statusBySourceId = { "7": "queued" };
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("7")] },
    ];
    const { dispatchNew } = await import("../services/dispatcher.js");
    await dispatchNew(candidates);
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      "/tmp/talos-loop", "/tmp/talos-worktrees/tl-github-talos-loop-7", "feat/issue-7", "develop",
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchReview: a done issue with an unresolved review subIssue
// ---------------------------------------------------------------------------

describe("dispatchReview() launches the in-review skill (issue #32)", () => {
  beforeEach(baseReset);

  it("dispatches a review session for a done issue with an unresolved review subIssue", async () => {
    const candidates: PollResult[] = [
      {
        projectId: "qiaolei1973/1",
        projectType: "github",
        discovered: [makeCandidate("9", "done", [{ type: "review", resolved: false }])],
      },
    ];

    const { dispatchReview } = await import("../services/dispatcher.js");
    const reviewed = await dispatchReview(candidates);

    expect(reviewed).toBe(1);
    // Reuses the existing feat branch (ensureWorktree, not createWorktree)…
    expect(mockEnsureWorktree).toHaveBeenCalledWith(
      "/tmp/talos-loop", "/tmp/talos-worktrees/tl-github-talos-loop-9-review", "feat/issue-9",
    );
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    // …records a review session…
    expect(mockCreateSession).toHaveBeenCalledWith(9, "tl-github-talos-loop-9-review", {
      type: "review",
      branch: "feat/issue-9",
      worktreePath: "/tmp/talos-worktrees/tl-github-talos-loop-9-review",
    });
    // …and does NOT touch the board (review never moves the stage).
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
    // The in-review skill is the launched invocation.
    expect(launcherScript()).toContain(`claude -p "/github-review 处理 issue：`);
  });

  it("skips when no 'in-review' skill is configured", async () => {
    stages = { ready: "github-code" }; // no in-review skill
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("9", "done", [{ type: "review", resolved: false }])] },
    ];
    const { dispatchReview } = await import("../services/dispatcher.js");
    expect(await dispatchReview(candidates)).toBe(0);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("skips when a review session is already running for the issue", async () => {
    runningReviewIssueIds = new Set([9]);
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("9", "done", [{ type: "review", resolved: false }])] },
    ];
    const { dispatchReview } = await import("../services/dispatcher.js");
    expect(await dispatchReview(candidates)).toBe(0);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("skips a done issue with no review subIssue (nothing to review)", async () => {
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("9", "done")] },
    ];
    const { dispatchReview } = await import("../services/dispatcher.js");
    expect(await dispatchReview(candidates)).toBe(0);
  });

  it("skips a queued issue (only done issues are review candidates)", async () => {
    const candidates: PollResult[] = [
      { projectId: "qiaolei1973/1", projectType: "github", discovered: [makeCandidate("9", "queued", [{ type: "review", resolved: false }])] },
    ];
    const { dispatchReview } = await import("../services/dispatcher.js");
    expect(await dispatchReview(candidates)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkRunningSessions: sentinel-based classification
// ---------------------------------------------------------------------------

describe("checkRunningSessions() — coding sessions (issue #32)", () => {
  beforeEach(baseReset);

  it("clean exit → writeLabel(processing→done) + board→done + remove worktree + kill", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 0;
    runningSessions = [makeRunningSession(session, { worktree_path: "/tmp/talos-worktrees/tl-github-talos-loop-9", branch: "feat/issue-9" })];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 1, failed: 0, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "done");
    // The ONLY board move: processing → done.
    expect(mockPlugin.writeLabel).toHaveBeenCalledWith(expect.anything(), "9", { from: "processing", to: "done" }, "talos-loop");
    expect(mockSetBoardStatus).toHaveBeenCalledWith("qiaolei1973/1", "9", "done");
    // No completion comment — the server no longer knows the PR (the skill owns it).
    expect(mockPlugin.writeComment).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).toHaveBeenCalledWith("/tmp/talos-loop", "/tmp/talos-worktrees/tl-github-talos-loop-9");
    expect(mockKillSession).toHaveBeenCalledWith(session);
  });

  it("clean exit + keepSessionOnSuccess → done but the window is kept", async () => {
    keepSessionOnSuccess = true;
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 0;
    runningSessions = [makeRunningSession(session)];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    await checkRunningSessions();

    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "done");
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("crash within retry budget + captured id → auto claude -r retry (no board move)", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 1;
    tmuxOutput[session] = "Error: rate limited";
    maxRetry = 1;
    runningSessions = [
      makeRunningSession(session, {
        retry_count: 0,
        claude_session_id: "claude-id-9",
        worktree_path: "/tmp/talos-worktrees/tl-github-talos-loop-9",
        branch: "feat/issue-9",
      }),
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 0, retried: 1 });
    // The crashed row is marked terminal…
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "failed", expect.stringContaining("rate limited"));
    // …the worktree is reused (ensureWorktree, not a fresh create)…
    expect(mockEnsureWorktree).toHaveBeenCalledWith("/tmp/talos-loop", "/tmp/talos-worktrees/tl-github-talos-loop-9", "feat/issue-9");
    // …a new running row records the incremented retry chain…
    expect(mockCreateSession).toHaveBeenCalledWith(9, "tl-github-talos-loop-9", {
      type: "coding",
      branch: "feat/issue-9",
      worktreePath: "/tmp/talos-worktrees/tl-github-talos-loop-9",
      retryCount: 1,
    });
    // …and the board is NOT touched (retry stays In progress).
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
    // The retry launches via `claude -r <id>` in print mode.
    expect(launcherScript()).toContain(`claude -r claude-id-9 -p`);
    expect(mockCreateTmuxSession).toHaveBeenCalledTimes(1);
  });

  it("crash with no captured id → failed (cannot resume), comment posted, worktree kept", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 1;
    tmuxOutput[session] = "boom";
    maxRetry = 1;
    runningSessions = [
      makeRunningSession(session, {
        retry_count: 0,
        claude_session_id: null, // nothing to resume from
        worktree_path: "/tmp/talos-worktrees/tl-github-talos-loop-9",
        branch: "feat/issue-9",
      }),
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "failed", expect.stringContaining("boom"));
    expect(mockPlugin.writeComment).toHaveBeenCalledTimes(1);
    // Worktree preserved for manual retry; board untouched.
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
  });

  it("crash with retries exhausted → failed + comment, worktree kept", async () => {
    const session = "tl-github-talos-loop-9";
    exitCodeBySession[session] = 1;
    tmuxOutput[session] = "still failing";
    maxRetry = 2;
    runningSessions = [
      makeRunningSession(session, {
        retry_count: 2, // already at the budget
        claude_session_id: "claude-id-9",
        worktree_path: "/tmp/talos-worktrees/tl-github-talos-loop-9",
        branch: "feat/issue-9",
      }),
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "failed", expect.stringContaining("still failing"));
    expect(mockPlugin.writeComment).toHaveBeenCalledTimes(1);
    expect(mockCreateTmuxSession).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it("missing sentinel → failed (unclean termination, nothing to resume), board untouched", async () => {
    const session = "tl-github-talos-loop-9";
    // exitCodeBySession[session] deliberately unset → no sentinel.
    // No captured claude id either → nothing to `claude -r` resume from.
    runningSessions = [makeRunningSession(session, { claude_session_id: null })];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "failed", expect.stringContaining("no exit-code sentinel"));
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
  });

  it("alive sessions are left alone", async () => {
    const session = "tl-github-talos-loop-9";
    tmuxAlive = new Set([session]);
    runningSessions = [makeRunningSession(session)];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 0, retried: 0 });
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
  });
});

describe("checkRunningSessions() — review sessions (issue #32)", () => {
  beforeEach(baseReset);

  it("clean review exit → done + remove worktree + kill, NO board move", async () => {
    const session = "tl-github-talos-loop-9-review";
    exitCodeBySession[session] = 0;
    runningSessions = [
      makeRunningSession(session, {
        source_id: "9",
        type: "review",
        worktree_path: "/tmp/talos-worktrees/tl-github-talos-loop-9-review",
        branch: "feat/issue-9",
      }),
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 1, failed: 0, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "done");
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).toHaveBeenCalledWith("/tmp/talos-loop", "/tmp/talos-worktrees/tl-github-talos-loop-9-review");
    expect(mockKillSession).toHaveBeenCalledWith(session);
  });

  it("crashed review exit → failed + remove worktree (implicit retry next tick), no board move", async () => {
    const session = "tl-github-talos-loop-9-review";
    exitCodeBySession[session] = 1;
    tmuxOutput[session] = "Error: review blew up";
    runningSessions = [
      makeRunningSession(session, {
        source_id: "9",
        type: "review",
        worktree_path: "/tmp/talos-worktrees/tl-github-talos-loop-9-review",
        branch: "feat/issue-9",
      }),
    ];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 1, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "failed", expect.stringContaining("blew up"));
    // Review cleans up its worktree on failure (it is re-dispatched fresh next tick).
    expect(mockRemoveWorktree).toHaveBeenCalledWith("/tmp/talos-loop", "/tmp/talos-worktrees/tl-github-talos-loop-9-review");
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
    // No claude -r retry for review (re-dispatched via the subIssue signal instead).
    expect(mockCreateTmuxSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// issue #30: capture claude's session id each cycle + wall-clock watchdog
// ---------------------------------------------------------------------------

describe("checkRunningSessions() persists the captured claude session id (issue #30)", () => {
  beforeEach(baseReset);

  it("writes the sidecar id to the DB row mid-run (available before completion)", async () => {
    const session = "tl-github-talos-loop-9";
    tmuxAlive = new Set([session]); // alive → not classified, but id is captured
    readSessionIdBySession[session] = "claude-session-abc";
    runningSessions = [makeRunningSession(session)];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(result).toEqual({ completed: 0, failed: 0, retried: 0 });
    expect(mockSetSessionClaudeId).toHaveBeenCalledWith(100, "claude-session-abc");
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
  });

  it("skips the write when the sidecar is absent", async () => {
    const session = "tl-github-talos-loop-9";
    tmuxAlive = new Set([session]);
    runningSessions = [makeRunningSession(session)];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    await checkRunningSessions();

    expect(mockSetSessionClaudeId).not.toHaveBeenCalled();
  });
});

describe("checkRunningSessions() wall-clock watchdog (issue #30)", () => {
  beforeEach(baseReset);

  it("kills an alive session past the limit → missing sentinel, no id to resume → failed", async () => {
    claudeTimeout = 1;
    const session = "tl-github-talos-loop-9";
    tmuxAlive = new Set([session]);
    // Hung before the init event wrote the sidecar → no captured id to resume from.
    runningSessions = [makeRunningSession(session, { started_at: "2020-01-01 00:00:00", claude_session_id: null })];

    const { checkRunningSessions } = await import("../services/dispatcher.js");
    const result = await checkRunningSessions();

    expect(mockKillSession).toHaveBeenCalledWith(session);
    expect(result).toEqual({ completed: 0, failed: 1, retried: 0 });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(100, "failed", expect.stringContaining("no exit-code sentinel"));
    expect(mockPlugin.writeLabel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispatch(): the assembled cycle
// ---------------------------------------------------------------------------

describe("dispatch() assembles check + new + review (issue #32)", () => {
  beforeEach(baseReset);

  it("runs review every cycle (no slow cadence counter) when subIssues persist", async () => {
    const candidates: PollResult[] = [
      {
        projectId: "qiaolei1973/1",
        projectType: "github",
        discovered: [makeCandidate("9", "done", [{ type: "review", resolved: false }])],
      },
    ];

    const mod = await import("../services/dispatcher.js");
    // Cycle 1.
    await mod.dispatch(candidates);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    // A running review session now exists → cycle 2 skips it (one per issue).
    runningReviewIssueIds = new Set([9]);
    await mod.dispatch(candidates);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it("reports idle when nothing is running and nothing dispatched", async () => {
    const mod = await import("../services/dispatcher.js");
    const result = await mod.dispatch([{ projectId: "qiaolei1973/1", projectType: "github", discovered: [] }]);
    expect(result.idle).toBe(true);
  });
});
