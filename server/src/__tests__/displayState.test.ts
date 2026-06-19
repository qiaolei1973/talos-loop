import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "../db/index.js";

// isSessionLive / deriveDisplayState read tmux.isAlive — drive it from state.
let aliveNames: Set<string> = new Set();

vi.mock("../services/tmux.js", () => ({
  isAlive: (name: string) => aliveNames.has(name),
}));

import { deriveDisplayState, isSessionLive, liveSessionName, mapBoardStatus } from "../services/displayState.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    issue_id: 9,
    tmux_session: "tl-x",
    status: "running",
    error: null,
    started_at: "",
    finished_at: null,
    type: "coding",
    branch: null,
    worktree_path: null,
    claude_session_id: null,
    retry_count: 0,
    ...overrides,
  };
}

describe("isSessionLive() (issue #19)", () => {
  beforeEach(() => {
    aliveNames = new Set();
  });

  it("is live only when status is running AND tmux reports the session alive", () => {
    // running + alive → live
    aliveNames = new Set(["tl-a"]);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "running" }))).toBe(true);
    // running but dead (zombie) → not live
    aliveNames = new Set();
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "running" }))).toBe(false);
    // alive-looking but already terminal → not live
    aliveNames = new Set(["tl-a"]);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "done" }))).toBe(false);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "failed" }))).toBe(false);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "killed" }))).toBe(false);
  });
});

describe("mapBoardStatus() — standard-state passthrough (issue #32)", () => {
  it("passes the standard states straight through", () => {
    expect(mapBoardStatus("queued")).toBe("queued");
    expect(mapBoardStatus("processing")).toBe("processing");
    expect(mapBoardStatus("done")).toBe("done");
  });

  it("returns null for unknown/empty values (indeterminate)", () => {
    expect(mapBoardStatus("Backlog")).toBeNull();
    expect(mapBoardStatus("Ready")).toBeNull(); // raw GitHub column names are no longer stored
    expect(mapBoardStatus("")).toBeNull();
    expect(mapBoardStatus(null)).toBeNull();
    expect(mapBoardStatus(undefined)).toBeNull();
  });
});

describe("deriveDisplayState() — stage badge is board-driven, review-unaffected (issue #19)", () => {
  beforeEach(() => {
    aliveNames = new Set();
  });

  it("a live CODING session overrides the board to processing", () => {
    aliveNames = new Set(["tl-c"]);
    const state = deriveDisplayState(
      [session({ tmux_session: "tl-c", type: "coding", status: "running" })],
      "queued",
    );
    expect(state).toBe("processing");
  });

  it("a live REVIEW session does NOT override the board — badge stays done", () => {
    aliveNames = new Set(["tl-r"]);
    const state = deriveDisplayState(
      [session({ tmux_session: "tl-r", type: "review", status: "running" })],
      "done",
    );
    // Board-driven (done), NOT processing — user story 9.
    expect(state).toBe("done");
  });

  it("a live review session never reads as processing even against a queued board", () => {
    aliveNames = new Set(["tl-r"]);
    const state = deriveDisplayState(
      [session({ tmux_session: "tl-r", type: "review", status: "running" })],
      "queued",
    );
    // The review session is invisible to the stage badge; the board state wins.
    expect(state).toBe("queued");
  });

  it("falls back to the board state when no session is live", () => {
    aliveNames = new Set();
    expect(deriveDisplayState([], "queued")).toBe("queued");
    expect(deriveDisplayState([], "processing")).toBe("processing");
    expect(deriveDisplayState([], "done")).toBe("done");
    expect(deriveDisplayState([], "Backlog")).toBeNull();
  });

  it("liveSessionName still surfaces a live review session as an attach target", () => {
    aliveNames = new Set(["tl-r"]);
    const name = liveSessionName([session({ tmux_session: "tl-r", type: "review", status: "running" })]);
    expect(name).toBe("tl-r");
  });
});
