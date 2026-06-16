import type { Session } from "../db/index.js";
import * as tmux from "./tmux.js";

/** The dashboard-facing status, derived on read (never persisted). */
export type DisplayState = "queued" | "processing" | "done" | null;

/**
 * Normalize a project-board column name for tolerant matching, reusing the same
 * rule the GitHub plugin applies to its single-select options: collapse to
 * lowercase and strip whitespace ("In progress" → "inprogress").
 */
export function norm(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/**
 * Map a raw board column name to a display state. Board column names are
 * source-specific (GitHub Projects: Ready / In progress / In review / Done);
 * this collapse tolerates case and spacing so minor column-name edits don't
 * cause a mismatch. Unknown / empty columns map to null (indeterminate).
 *
 *   ready       → queued
 *   inprogress  → processing
 *   inreview    → done   (PR created)
 *   done        → done   (PR merged — advanced by GitHub's own automation)
 */
export function mapBoardStatus(boardStatus: string | null | undefined): DisplayState {
  switch (norm(boardStatus ?? "")) {
    case "ready":
      return "queued";
    case "inprogress":
      return "processing";
    case "inreview":
    case "done":
      return "done";
    default:
      return null;
  }
}

/**
 * Derive an issue's display status from the two sources of truth (issue #13).
 * The GitHub Projects board column is the sole source of workflow truth, EXCEPT
 * that a live CODING session always reads as "processing" — so a board
 * hand-moved to Ready mid-flight doesn't mis-report an actively-running agent.
 *
 * A live REVIEW session does NOT override the board (issue #19, user story 9):
 * review sessions are short-lived workers on a PR that is already "In review",
 * and the stage badge must stay stable and board-driven while one runs. (Its
 * liveness is shown separately as a per-session `isLive` indicator.)
 *
 *   running CODING session AND tmux.isAlive → processing
 *   otherwise mapBoardStatus(board column)
 */
export function deriveDisplayState(
  sessions: Session[],
  boardStatus: string | null | undefined,
): DisplayState {
  if (sessions.some((s) => s.status === "running" && s.type !== "review" && tmux.isAlive(s.tmux_session))) {
    return "processing";
  }
  return mapBoardStatus(boardStatus);
}

/**
 * Is a session currently live (issue #19, user stories 8 & 10)? True only when
 * the session row is `running` and tmux still reports the process alive — the
 * same invariant `deriveDisplayState` and `liveSessionName` use. Surfaced per
 * session row in the dashboard so an attach button can be offered on any live
 * session, coding or review, independent of the board stage badge.
 */
export function isSessionLive(session: Session): boolean {
  return session.status === "running" && tmux.isAlive(session.tmux_session);
}

/**
 * The tmux session name to offer an "attach" link for, if a running session is
 * still alive. Null when nothing is live (e.g. a board "In progress" item whose
 * session died — a zombie — has nothing to attach to).
 */
export function liveSessionName(sessions: Session[]): string | null {
  const live = sessions.find((s) => s.status === "running" && tmux.isAlive(s.tmux_session));
  return live?.tmux_session ?? null;
}
