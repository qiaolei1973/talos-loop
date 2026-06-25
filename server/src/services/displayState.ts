import type { Session } from "../db/index.js";
import * as tmux from "./tmux.js";

/** The dashboard-facing status, derived on read (never persisted). */
export type DisplayState = "ready" | "inprogress" | "inreview" | null;

/**
 * Map a board-snapshot value (a standard core state written by the poller from
 * list().state, or an optimistic flip) to a display state. The board snapshot
 * (issue #32) now stores standard states directly — the source plugin's list()
 * already translated its platform-specific column into ready/inprogress/inreview —
 * so this is a passthrough + validity check. Unknown/empty → null (indeterminate).
 *
 *   ready       → ready       (Ready)
 *   inprogress  → inprogress  (In progress)
 *   inreview    → inreview    (In review; "Done"/merged is excluded upstream)
 */
export function mapBoardStatus(boardStatus: string | null | undefined): DisplayState {
  switch (boardStatus ?? "") {
    case "ready":
      return "ready";
    case "inprogress":
      return "inprogress";
    case "inreview":
      return "inreview";
    default:
      return null;
  }
}

/**
 * Derive an issue's display status from the two sources of truth. The board
 * snapshot's standard state is the sole source of workflow truth, EXCEPT that a
 * live CODING session always reads as "inprogress" — so a board hand-moved to
 * Ready mid-flight doesn't mis-report an actively-running agent.
 *
 * A live REVIEW session does NOT override the board: review sessions are
 * short-lived workers on a PR that is already "In review", and the stage badge
 * must stay stable and board-driven while one runs. (Its liveness is shown
 * separately as a per-session `isLive` indicator.)
 *
 *   running CODING session AND tmux.isAlive → inprogress
 *   otherwise mapBoardStatus(snapshot state)
 */
export async function deriveDisplayState(
  sessions: Session[],
  boardStatus: string | null | undefined,
): Promise<DisplayState> {
  for (const s of sessions) {
    if (s.status === "running" && s.type !== "review" && await tmux.isAlive(s.tmux_session)) {
      return "inprogress";
    }
  }
  return mapBoardStatus(boardStatus);
}

/**
 * Is a session currently live? True only when the session row is `running` and
 * tmux still reports the process alive — the same invariant `deriveDisplayState`
 * and `liveSessionName` use. Surfaced per session row in the dashboard so an
 * attach button can be offered on any live session, coding or review.
 */
export async function isSessionLive(session: Session): Promise<boolean> {
  return session.status === "running" && await tmux.isAlive(session.tmux_session);
}

/**
 * The tmux session name to offer an "attach" link for, if a running session is
 * still alive. Null when nothing is live (e.g. a board "inprogress" item whose
 * session died — a zombie — has nothing to attach to).
 */
export async function liveSessionName(sessions: Session[]): Promise<string | null> {
  for (const s of sessions) {
    if (s.status === "running" && await tmux.isAlive(s.tmux_session)) {
      return s.tmux_session;
    }
  }
  return null;
}
