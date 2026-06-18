import type { Session } from "../db/index.js";
import * as tmux from "./tmux.js";

/** The dashboard-facing status, derived on read (never persisted). */
export type DisplayState = "queued" | "processing" | "done" | null;

/**
 * Map a board-snapshot value (a standard core state written by the poller from
 * list().state, or an optimistic flip) to a display state. The board snapshot
 * (issue #32) now stores standard states directly — the source plugin's list()
 * already translated its platform-specific column into queued/processing/done —
 * so this is a passthrough + validity check. Unknown/empty → null (indeterminate).
 *
 *   queued      → queued      (Ready)
 *   processing  → processing  (In progress)
 *   done        → done        (In review; "Done"/merged is excluded upstream)
 */
export function mapBoardStatus(boardStatus: string | null | undefined): DisplayState {
  switch (boardStatus ?? "") {
    case "queued":
      return "queued";
    case "processing":
      return "processing";
    case "done":
      return "done";
    default:
      return null;
  }
}

/**
 * Derive an issue's display status from the two sources of truth. The board
 * snapshot's standard state is the sole source of workflow truth, EXCEPT that a
 * live CODING session always reads as "processing" — so a board hand-moved to
 * Ready mid-flight doesn't mis-report an actively-running agent.
 *
 * A live REVIEW session does NOT override the board: review sessions are
 * short-lived workers on a PR that is already "In review", and the stage badge
 * must stay stable and board-driven while one runs. (Its liveness is shown
 * separately as a per-session `isLive` indicator.)
 *
 *   running CODING session AND tmux.isAlive → processing
 *   otherwise mapBoardStatus(snapshot state)
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
 * Is a session currently live? True only when the session row is `running` and
 * tmux still reports the process alive — the same invariant `deriveDisplayState`
 * and `liveSessionName` use. Surfaced per session row in the dashboard so an
 * attach button can be offered on any live session, coding or review.
 */
export function isSessionLive(session: Session): boolean {
  return session.status === "running" && tmux.isAlive(session.tmux_session);
}

/**
 * The tmux session name to offer an "attach" link for, if a running session is
 * still alive. Null when nothing is live (e.g. a board "processing" item whose
 * session died — a zombie — has nothing to attach to).
 */
export function liveSessionName(sessions: Session[]): string | null {
  const live = sessions.find((s) => s.status === "running" && tmux.isAlive(s.tmux_session));
  return live?.tmux_session ?? null;
}
