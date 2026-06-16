import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// Plugin methods are vi.fns so each test can stub a different outcome.
const mockPlugin = {
  name: "github",
  submitPr: vi.fn(),
  onComment: vi.fn(),
  skip: vi.fn(),
  resolveThread: vi.fn(), // issue #19
};

// DB coordination helpers are vi.fns so tests assert they were called.
const mockGetIssue = vi.fn();
const mockSetSessionPrUrl = vi.fn();
const mockSetSessionBranch = vi.fn(); // issue #19: submit-pr records the PR head branch
const mockMarkSessionSkipped = vi.fn();
// The skip action optimistically flips the in-memory board snapshot to "Ready"
// (issue #13) — no persisted status/tmux column is written anymore.
const mockSetBoardStatus = vi.fn();

vi.mock("../config.js", () => ({
  loadConfig: () => ({ port: 3100, pollInterval: 60_000, maxParallel: 1, serverBaseUrl: "http://127.0.0.1:3100" }),
  getEnabledProjects: () => [],
  loadProjects: () => [],
  getProjectById: () => ({ projectId: "qiaolei1973/1", projectType: "github", enabled: true, repos: [], config: {} }),
  buildProjectContext: () => ({
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repos: [],
    projectId: "qiaolei1973/1",
  }),
}));

vi.mock("../db/index.js", () => ({
  getIssue: mockGetIssue,
  setSessionPrUrl: mockSetSessionPrUrl,
  setSessionBranch: mockSetSessionBranch, // issue #19: submit-pr records the PR head branch
  markSessionSkipped: mockMarkSessionSkipped,
  // Exported by db/index but unused by the action route — present so the mock
  // satisfies api.ts's named imports.
  getAllIssues: vi.fn(),
  getIssuesByTargetRepo: vi.fn(),
  getSessionsByIssue: vi.fn(),
  getIssueById: vi.fn(),
  getRunningSessions: vi.fn(),
}));

vi.mock("../services/boardSnapshot.js", () => ({
  setBoardStatus: mockSetBoardStatus,
  getBoardStatus: vi.fn(),
  setProjectBoard: vi.fn(),
  clearBoardSnapshot: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolvePlugin: async () => mockPlugin,
  getPluginName: async () => "github",
}));

// Keep the poller/dispatcher out of the route test entirely.
vi.mock("../services/poller.js", () => ({ pollAll: vi.fn() }));
vi.mock("../services/dispatcher.js", () => ({ dispatch: vi.fn() }));
vi.mock("../services/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ISSUE = { id: 42, project_id: "qiaolei1973/1", source_id: "9", target_repo: "talos-loop" };

async function buildApp() {
  // Dynamic import defers api.js load (and thus the mock factories) until after
  // the top-level vi.fns are initialized — same lazy-load pattern as
  // dispatcher.test.ts.
  const { registerApiRoutes } = await import("../routes/api.js");
  const app = Fastify();
  await registerApiRoutes(app);
  await app.ready();
  return app;
}

describe("POST /api/projects/:projectId/issues/:sourceId/actions/:action", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetIssue.mockReturnValue(ISSUE);
    mockPlugin.submitPr.mockReset();
    mockPlugin.onComment.mockReset();
    mockPlugin.skip.mockReset();
    mockPlugin.resolveThread.mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("submit-pr → plugin.submitPr returns URL, persisted via setSessionPrUrl", async () => {
    mockPlugin.submitPr.mockResolvedValue("https://github.com/qiaolei1973/talos-loop/pull/7");

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/submit-pr",
      payload: { branch: "feat/x", targetRepo: "talos-loop" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, prUrl: "https://github.com/qiaolei1973/talos-loop/pull/7" });
    expect(mockPlugin.submitPr).toHaveBeenCalledWith(expect.anything(), "9", "feat/x", "talos-loop");
    expect(mockSetSessionPrUrl).toHaveBeenCalledWith(42, "https://github.com/qiaolei1973/talos-loop/pull/7");
    // issue #19: submit-pr also records the PR head branch so a later review
    // dispatch can push fixes to it.
    expect(mockSetSessionBranch).toHaveBeenCalledWith(42, "feat/x");
    // submit-pr performs no skip-style coordination.
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  it("submit-pr without a branch → 200 error body, plugin not called", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/submit-pr",
      payload: { targetRepo: "talos-loop" },
    });
    expect(res.json().error).toMatch(/branch required/);
    expect(mockPlugin.submitPr).not.toHaveBeenCalled();
    expect(mockSetSessionPrUrl).not.toHaveBeenCalled();
  });

  it("submit-pr surfaces a plugin error and does not persist a URL", async () => {
    mockPlugin.submitPr.mockRejectedValue(new Error("branch not pushed"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/submit-pr",
      payload: { branch: "feat/x", targetRepo: "talos-loop" },
    });
    expect(res.json().error).toMatch(/branch not pushed/);
    expect(mockSetSessionPrUrl).not.toHaveBeenCalled();
  });

  it("skip → plugin.skip plus coordination (markSessionSkipped, optimistic board flip to Ready)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/skip",
      payload: { reason: "needs more info", targetRepo: "talos-loop" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockPlugin.skip).toHaveBeenCalledWith(expect.anything(), "9", "talos-loop", "needs more info");
    expect(mockMarkSessionSkipped).toHaveBeenCalledWith(42, "needs more info");
    // Issue #13: no persisted status column — the board move happened in
    // plugin.skip(); we only mirror it optimistically to "Ready" in memory.
    expect(mockSetBoardStatus).toHaveBeenCalledWith("qiaolei1973/1", "9", "Ready");
  });

  it("skip defaults the reason when none is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/skip",
      payload: { targetRepo: "talos-loop" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockPlugin.skip).toHaveBeenCalledWith(expect.anything(), "9", "talos-loop", "No reason provided");
    expect(mockMarkSessionSkipped).toHaveBeenCalledWith(42, "No reason provided");
  });

  it("comment → plugin.onComment, no coordination DB ops", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/comment",
      payload: { message: "checking in", targetRepo: "talos-loop" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockPlugin.onComment).toHaveBeenCalledWith(expect.anything(), "9", "checking in", "talos-loop");
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
    expect(mockSetSessionPrUrl).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  it("resolve-thread → plugin.resolveThread(sourceId, prUrl, threadId), no DB coordination", async () => {
    mockPlugin.resolveThread.mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/resolve-thread",
      payload: {
        targetRepo: "talos-loop",
        prUrl: "https://github.com/qiaolei1973/talos-loop/pull/42",
        threadId: "PRRT_kwDOS2N8m85L2XHk",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockPlugin.resolveThread).toHaveBeenCalledWith(
      expect.anything(),
      "9",
      "https://github.com/qiaolei1973/talos-loop/pull/42",
      "PRRT_kwDOS2N8m85L2XHk",
    );
    // resolve-thread performs no session/board coordination.
    expect(mockSetSessionPrUrl).not.toHaveBeenCalled();
    expect(mockSetSessionBranch).not.toHaveBeenCalled();
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
    expect(mockSetBoardStatus).not.toHaveBeenCalled();
  });

  it("resolve-thread without prUrl/threadId → 200 error body, plugin not called", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/resolve-thread",
      payload: { targetRepo: "talos-loop", threadId: "PRRT_x" },
    });
    expect(res.json().error).toMatch(/prUrl and threadId required/);
    expect(mockPlugin.resolveThread).not.toHaveBeenCalled();
  });

  it("unknown action → 400 error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/bogus",
      payload: { targetRepo: "talos-loop" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unknown action/);
  });
});
