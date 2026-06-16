import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { ComponentType, ReactNode } from "react";
import App from "../App";

// Shared fixture: one processing issue (with a PR) and one done issue.
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
        pr_url: "https://github.com/owner/talos-loop/pull/17",
        error: null,
        started_at: "2026-06-16 00:00:00",
        finished_at: null,
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

  it("renders rows, status badges, PR link, and header count from the API", async () => {
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

    // PR link for the latest processing session.
    const prLink = screen.getByRole("link", { name: "PR" });
    expect(prLink).toHaveAttribute("href", "https://github.com/owner/talos-loop/pull/17");

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
});
