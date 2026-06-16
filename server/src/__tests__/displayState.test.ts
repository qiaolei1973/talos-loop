import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "../db/index.js";

// isSessionLive / deriveDisplayState read tmux.isAlive — drive it from state.
let aliveNames: Set<string> = new Set();

vi.mock("../services/tmux.js", () => ({
  isAlive: (name: string) => aliveNames.has(name),
}));

import { deriveDisplayState, isSessionLive, liveSessionName } from "../services/displayState.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    issue_id: 9,
    tmux_session: "tl-x",
    status: "running",
    pr_url: null,
    error: null,
    started_at: "",
    finished_at: null,
    type: "coding",
    branch: null,
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
    // alive-looking but already done → not live
    aliveNames = new Set(["tl-a"]);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "done" }))).toBe(false);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "failed" }))).toBe(false);
    expect(isSessionLive(session({ tmux_session: "tl-a", status: "skipped" }))).toBe(false);
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
      "Ready",
    );
    expect(state).toBe("processing");
  });

  it("a live REVIEW session does NOT override the board — badge stays In review (done)", () => {
    aliveNames = new Set(["tl-r"]);
    const state = deriveDisplayState(
      [session({ tmux_session: "tl-r", type: "review", status: "running" })],
      "In review",
    );
    // Board-driven (In review → done), NOT processing — user story 9.
    expect(state).toBe("done");
  });

  it("a live review session never reads as processing even against a Ready board", () => {
    aliveNames = new Set(["tl-r"]);
    const state = deriveDisplayState(
      [session({ tmux_session: "tl-r", type: "review", status: "running" })],
      "Ready",
    );
    // The review session is invisible to the stage badge; the board column wins.
    expect(state).toBe("queued");
  });

  it("liveSessionName still surfaces a live review session as an attach target", () => {
    aliveNames = new Set(["tl-r"]);
    const name = liveSessionName([session({ tmux_session: "tl-r", type: "review", status: "running" })]);
    expect(name).toBe("tl-r");
  });
});
