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
 * that a live tmux session always reads as "processing" — so a board hand-moved
 * to Ready mid-flight doesn't mis-report an actively-running agent.
 *
 *   running session AND tmux.isAlive → processing
 *   otherwise mapBoardStatus(board column)
 */
export function deriveDisplayState(
  sessions: Session[],
  boardStatus: string | null | undefined,
): DisplayState {
  if (sessions.some((s) => s.status === "running" && tmux.isAlive(s.tmux_session))) {
    return "processing";
  }
  return mapBoardStatus(boardStatus);
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
