import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { Issue, Session } from "../db/index.js";

// --- per-test controllable state (read lazily inside the mocked modules) ---
let issuesState: Issue[] = [];
let sessionsByIssue: Record<number, Session[]> = {};
/** board snapshot: `${projectId}/${sourceId}` → raw board column name. */
let boardByIssue: Record<string, string | undefined> = {};
let aliveSessionNames: Set<string> = new Set();

vi.mock("../config.js", () => ({
  loadConfig: () => ({ port: 3100, pollInterval: 60_000, maxParallel: 1, serverBaseUrl: "http://127.0.0.1:3100" }),
  getEnabledProjects: () => [],
  loadProjects: () => [],
  getProjectById: () => undefined,
  buildProjectContext: () => ({
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repos: [],
    projectId: "qiaolei1973/1",
  }),
}));

vi.mock("../db/index.js", () => ({
  getAllIssues: () => issuesState,
  getSessionsByIssue: (id: number) => sessionsByIssue[id] ?? [],
  getIssuesByTargetRepo: () => [],
  getIssueById: () => undefined,
  getIssue: () => undefined,
  getRunningSessions: () => [],
  markSessionSkipped: vi.fn(),
  setSessionPrUrl: vi.fn(),
}));

vi.mock("../services/boardSnapshot.js", () => ({
  getBoardStatus: (projectId: string, sourceId: string) => boardByIssue[`${projectId}/${sourceId}`],
  setBoardStatus: vi.fn(),
  setProjectBoard: vi.fn(),
  clearBoardSnapshot: vi.fn(),
}));

// displayState.ts imports tmux directly; stubbing isAlive here drives both the
// "live session → processing" precedence and the attach-target derivation.
vi.mock("../services/tmux.js", () => ({
  isAlive: (name: string) => aliveSessionNames.has(name),
}));

vi.mock("../plugins/loader.js", () => ({
  resolvePlugin: async () => ({ name: "github" }),
  getPluginName: async () => "github",
}));

// Keep the poll/dispatch cycle out of this read-only route test.
vi.mock("../services/poller.js", () => ({ pollAll: vi.fn() }));
vi.mock("../services/dispatcher.js", () => ({ dispatch: vi.fn() }));
vi.mock("../services/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 9,
    project_id: "qiaolei1973/1",
    project_type: "github",
    source_id: "9",
    target_repo: "talos-loop",
    url: "https://github.com/qiaolei1973/talos-loop/issues/9",
    title: "Issue 9",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    issue_id: 9,
    tmux_session: "tl-github-talos-loop-9",
    status: "running",
    pr_url: null,
    error: null,
    started_at: "",
    finished_at: null,
    ...overrides,
  };
}

async function buildApp() {
  // Dynamic import defers api.js load (and thus the mock factories) until after
  // the top-level state is initialized.
  const { registerApiRoutes } = await import("../routes/api.js");
  const app = Fastify();
  await registerApiRoutes(app);
  await app.ready();
  return app;
}

async function issuesJson(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: "GET", url: "/api/issues" });
  expect(res.statusCode).toBe(200);
  return (await res.json()) as Array<
    Issue & { project_name: string; status: string | null; tmux_session: string | null; sessions: Session[] }
  >;
}

/**
 * Seam 1 (issue #13): the highest-level black-box test. `status` is now a DERIVED
 * value surfaced by GET /api/issues — sourced from the in-memory board snapshot
 * + the sessions table + a live-tmux check. These cover every "what does the
 * dashboard show" story, including post-merge visibility.
 */
describe("GET /api/issues — derived display status (issue #13)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    issuesState = [];
    sessionsByIssue = {};
    boardByIssue = {};
    aliveSessionNames = new Set();
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("board Ready, no session → queued", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "Ready";
    const body = await issuesJson(app);
    expect(body[0].status).toBe("queued");
    expect(body[0].tmux_session).toBeNull();
  });

  it("running session alive → processing (board column ignored)", async () => {
    issuesState = [makeIssue()];
    // Board still says Ready, but a live agent session overrides it.
    boardByIssue["qiaolei1973/1/9"] = "Ready";
    sessionsByIssue[9] = [makeSession({ status: "running", tmux_session: "tl-live" })];
    aliveSessionNames = new Set(["tl-live"]);

    const body = await issuesJson(app);
    expect(body[0].status).toBe("processing");
    expect(body[0].tmux_session).toBe("tl-live");
  });

  it("board In review → done", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "In review";
    const body = await issuesJson(app);
    expect(body[0].status).toBe("done");
  });

  it("board Done (post-merge) → done", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "Done";
    const body = await issuesJson(app);
    expect(body[0].status).toBe("done");
  });

  it("board In progress but no live session → processing (zombie), nothing to attach", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "In progress";
    // A dead running session must NOT count as processing-via-session, but the
    // board column still reads In progress → processing (the incident #11 shape).
    sessionsByIssue[9] = [makeSession({ status: "running", tmux_session: "tl-dead" })];
    aliveSessionNames = new Set(); // session not alive

    const body = await issuesJson(app);
    expect(body[0].status).toBe("processing");
    expect(body[0].tmux_session).toBeNull();
  });

  it("board In progress is matched case/space-tolerantly", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "in Progress"; // odd casing/spacing
    const body = await issuesJson(app);
    expect(body[0].status).toBe("processing");
  });

  it("unknown board column + no live session → null (indeterminate)", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "Backlog";
    const body = await issuesJson(app);
    expect(body[0].status).toBeNull();
  });

  it("PR link comes from the latest session's pr_url", async () => {
    issuesState = [makeIssue()];
    boardByIssue["qiaolei1973/1/9"] = "In review";
    // getSessionsByIssue returns started_at DESC — index 0 is the latest.
    sessionsByIssue[9] = [
      makeSession({ id: 2, status: "done", pr_url: "https://github.com/qiaolei1973/talos-loop/pull/42" }),
      makeSession({ id: 1, status: "failed", pr_url: null, error: "boom" }),
    ];

    const body = await issuesJson(app);
    expect(body[0].sessions[0].pr_url).toBe("https://github.com/qiaolei1973/talos-loop/pull/42");
    // The failed session's error tail is still surfaced for triage.
    expect(body[0].sessions[1].error).toBe("boom");
  });

  it("still carries source/title/repo identity (display cache) and project_name", async () => {
    issuesState = [makeIssue({ title: "Derive status", source_id: "13", target_repo: "talos-loop" })];
    boardByIssue["qiaolei1973/1/13"] = "Ready";
    const body = await issuesJson(app);
    expect(body[0].source_id).toBe("13");
    expect(body[0].title).toBe("Derive status");
    expect(body[0].target_repo).toBe("talos-loop");
    expect(body[0].project_name).toBe("github");
  });
});
