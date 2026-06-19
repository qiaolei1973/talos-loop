import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { ComponentType, ReactNode } from "react";
import App from "../App";

// Shared fixture: one processing issue and one done issue.
const issuesFixture = [
  {
    id: 1,
    project_id: "owner/1",
    project_type: "github",
    project_name: "demo-project",
    source_id: "16",
    target_repo: "talos-loop",
    url: "https://github.com/owner/talos-loop/issues/16",
    title: "feat: replace manual setInterval polling",
    status: "processing",
    tmux_session: "sess-1",
    sessions: [
      {
        id: 10,
        tmux_session: "sess-1",
        status: "running",
        error: null,
        started_at: "2026-06-16 00:00:00",
        finished_at: null,
        type: "coding",
        isLive: true,
      },
    ],
    created_at: "2026-06-16 00:00:00",
    updated_at: "2026-06-16 00:00:00",
  },
  {
    id: 2,
    project_id: "owner/1",
    project_type: "github",
    project_name: "demo-project",
    source_id: "5",
    target_repo: "talos-loop",
    url: "https://github.com/owner/talos-loop/issues/5",
    title: "feat: split config out of repos",
    status: "done",
    tmux_session: null,
    sessions: [],
    created_at: "2026-06-15 00:00:00",
    updated_at: "2026-06-15 00:00:00",
  },
];

const statusFixture = {
  status: "ok",
  runningCount: 1,
  maxParallel: 2,
  lastPollAt: "2026-06-16 00:00:00",
  nextPollAt: null,
  pollInterval: 60000,
};

// Request counters let us assert "exactly one fetch per endpoint on first
// paint" and "Poll Now triggers a refetch" without coupling to the hook impl.
let issuesGets = 0;
let statusGets = 0;
let pollPosts = 0;
let killPosts = 0;

const server = setupServer(
  http.get("/api/issues", () => {
    issuesGets += 1;
    return HttpResponse.json(issuesFixture);
  }),
  http.get("/api/status", () => {
    statusGets += 1;
    return HttpResponse.json(statusFixture);
  }),
  http.post("/api/poll", () => {
    pollPosts += 1;
    return HttpResponse.json({ ok: true });
  }),
  // issue #26: the kill endpoint the dashboard's Kill button hits.
  http.post("/api/sessions/:id/kill", () => {
    killPosts += 1;
    return HttpResponse.json({ success: true, status: "killed" });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  // RTL's auto-cleanup relies on a global afterEach hook; since we import the
  // vitest primitives explicitly, unmount here so rendered DOM doesn't leak
  // across tests (otherwise findByText sees stale duplicates).
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function resetCounters() {
  issuesGets = 0;
  statusGets = 0;
  pollPosts = 0;
  killPosts = 0;
}

// A fresh, deterministic client per render: no retries, no focus refetch, data
// stays fresh so the only fetches are the ones the test drives explicitly.
function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<App />, { wrapper: Wrapper as ComponentType<{ children: ReactNode }> });
}

describe("App dashboard", () => {
  beforeEach(() => resetCounters());

  it("renders rows, status badges, and header count from the API", async () => {
    renderApp();

    // Header running-count badge derived from /api/status.
    expect(await screen.findByText("1/2 running")).toBeInTheDocument();

    // Grouped by repo, with the per-repo issue count.
    expect(await screen.findByText("2 issues")).toBeInTheDocument();

    // Issue source-id links and titles.
    expect(screen.getByText("#16")).toBeInTheDocument();
    expect(screen.getByText("#5")).toBeInTheDocument();
    expect(screen.getByText("feat: replace manual setInterval polling")).toBeInTheDocument();
    expect(screen.getByText("feat: split config out of repos")).toBeInTheDocument();

    // Status badges: processing → "In progress", done → "In review".
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("In review")).toBeInTheDocument();

    // Exactly one GET per endpoint on first paint — no duplicate/overlapping
    // fetches even though the app renders two independent queries.
    await waitFor(() => expect(issuesGets).toBe(1));
    await waitFor(() => expect(statusGets).toBe(1));
  });

  it("shows the empty state once loaded when there are no issues", async () => {
    server.use(http.get("/api/issues", () => HttpResponse.json([])));
    renderApp();

    expect(await screen.findByText("No issues found yet.")).toBeInTheDocument();
    expect(screen.queryByText("Loading issues…")).not.toBeInTheDocument();
  });

  it('clicking "Poll Now" posts /api/poll and refetches issues', async () => {
    const user = userEvent.setup();
    renderApp();

    // Wait for the initial load to settle before interacting.
    await screen.findByText("1/2 running");
    await waitFor(() => expect(issuesGets).toBe(1));
    expect(pollPosts).toBe(0);

    await user.click(screen.getByRole("button", { name: /Poll Now/i }));

    await waitFor(() => expect(pollPosts).toBe(1));
    await waitFor(() => expect(issuesGets).toBe(2));
  });

  // issue #19: an issue's session group shows every session (coding + review),
  // an attach button on the live review session, and the stage badge stays
  // board-driven ("In review") despite the live review session.
  it("renders a coding+review session group with a live attach and a stable stage badge", async () => {
    const reviewIssue = {
      id: 3,
      project_id: "owner/1",
      project_type: "github",
      project_name: "demo-project",
      source_id: "19",
      target_repo: "talos-loop",
      url: "https://github.com/owner/talos-loop/issues/19",
      title: "feat: auto-fix PR review comments",
      status: "done", // board "In review" → done, NOT processing, even with a live review session
      tmux_session: "sess-review",
      sessions: [
        {
          id: 20,
          tmux_session: "tl-dead",
          status: "done",
          error: null,
          started_at: "2026-06-15 00:00:00",
          finished_at: "2026-06-15 00:01:00",
          type: "coding",
          isLive: false,
        },
        {
          id: 21,
          tmux_session: "sess-review",
          status: "running",
          error: null,
          started_at: "2026-06-16 00:00:00",
          finished_at: null,
          type: "review",
          isLive: true,
        },
      ],
      created_at: "2026-06-15 00:00:00",
      updated_at: "2026-06-16 00:00:00",
    };
    server.use(http.get("/api/issues", () => HttpResponse.json([reviewIssue])));

    renderApp();

    // Stage badge stays board-driven: "In review" (done), never "In progress".
    expect(await screen.findByText("In review")).toBeInTheDocument();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();

    // Both session types are surfaced in the group (the done coding chip shows
    // "coding · …"; the live review chip shows "review" in its own span).
    expect(screen.getAllByText(/^coding/).length).toBe(1);
    expect(screen.getAllByText(/^review$/).length).toBe(1);

    // The live review session offers an attach button; the (dead) coding one does not.
    expect(screen.getAllByRole("button", { name: /attach/i }).length).toBe(1);
  });

  // issue #26: a live running session shows a Kill button that POSTs the kill
  // action to the session endpoint, then refetches issues.
  it("shows a Kill button on a live session and POSTs the kill action on click", async () => {
    // The default fixture's issue #16 has one live running coding session (id 10).
    server.use(
      http.get("/api/issues", () => {
        issuesGets += 1;
        return HttpResponse.json(issuesFixture);
      }),
    );
    // The kill button prompts for confirmation — accept it.
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    renderApp();

    const killBtn = await screen.findByRole("button", { name: /kill/i });
    expect(killBtn).toBeInTheDocument();

    await user.click(killBtn);

    // The kill action was posted to the session URL, and issues refetch.
    await waitFor(() => expect(killPosts).toBe(1));
    await waitFor(() => expect(issuesGets).toBeGreaterThan(1));
    expect(window.confirm).toHaveBeenCalled();
    vi.mocked(window.confirm).mockRestore();
  });
});
