import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// Plugin methods are vi.fns so each test can stub a different outcome.
const mockPlugin = {
  name: "github",
  submitPr: vi.fn(),
  onComment: vi.fn(),
  skip: vi.fn(),
};

// DB coordination helpers are vi.fns so tests assert they were called.
const mockGetIssue = vi.fn();
const mockSetSessionPrUrl = vi.fn();
const mockMarkSessionSkipped = vi.fn();
const mockUpdateIssueStatus = vi.fn();
const mockUpdateIssueTmux = vi.fn();

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
  markSessionSkipped: mockMarkSessionSkipped,
  updateIssueStatus: mockUpdateIssueStatus,
  updateIssueTmux: mockUpdateIssueTmux,
  // Exported by db/index but unused by the action route — present so the mock
  // satisfies api.ts's named imports.
  getAllIssues: vi.fn(),
  getIssuesByTargetRepo: vi.fn(),
  getSessionsByIssue: vi.fn(),
  getIssueById: vi.fn(),
  getRunningSessions: vi.fn(),
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
    // submit-pr performs no skip-style coordination.
    expect(mockMarkSessionSkipped).not.toHaveBeenCalled();
    expect(mockUpdateIssueStatus).not.toHaveBeenCalled();
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

  it("skip → plugin.skip plus coordination DB ops (markSessionSkipped, updateIssueStatus, updateIssueTmux)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/qiaolei1973%2F1/issues/9/actions/skip",
      payload: { reason: "needs more info", targetRepo: "talos-loop" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockPlugin.skip).toHaveBeenCalledWith(expect.anything(), "9", "talos-loop", "needs more info");
    expect(mockMarkSessionSkipped).toHaveBeenCalledWith(42, "needs more info");
    expect(mockUpdateIssueStatus).toHaveBeenCalledWith("qiaolei1973/1", "9", "queued");
    expect(mockUpdateIssueTmux).toHaveBeenCalledWith("qiaolei1973/1", "9", null);
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
    expect(mockUpdateIssueStatus).not.toHaveBeenCalled();
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
