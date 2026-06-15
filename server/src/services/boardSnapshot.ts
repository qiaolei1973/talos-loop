/**
 * In-memory snapshot of the GitHub Projects board, keyed per project → source id.
 *
 * NOT persisted. Rebuilt every poll cycle from the plugin's `listBoard()` and
 * consumed by display-state derivation (services/displayState.ts). Keeping the
 * board's view in memory — rather than mirroring it into the `issues` table — is
 * what makes the board the single writer of workflow status: nothing else stores
 * a copy that could drift from it (issue #13).
 *
 * The value is the raw board column name (e.g. "Ready", "In progress"); the
 * display layer normalizes it for matching.
 */
const snapshot = new Map<string, Map<string, string>>();

function sliceFor(projectId: string): Map<string, string> {
  let slice = snapshot.get(projectId);
  if (!slice) {
    slice = new Map();
    snapshot.set(projectId, slice);
  }
  return slice;
}

/** Replace a project's entire board slice (called once per poll cycle). */
export function setProjectBoard(projectId: string, items: Map<string, string>): void {
  snapshot.set(projectId, items);
}

/** Look up the current board column for an issue, or undefined if unknown. */
export function getBoardStatus(projectId: string, sourceId: string): string | undefined {
  return snapshot.get(projectId)?.get(sourceId);
}

/**
 * Optimistically set a single issue's board column between polls so the dashboard
 * reflects a dispatch / completion / skip immediately, before the next poll
 * re-reads the board (issue #13: snappy dashboard after dispatch).
 */
export function setBoardStatus(projectId: string, sourceId: string, boardStatus: string): void {
  sliceFor(projectId).set(sourceId, boardStatus);
}

/** Drop all cached board state (test helper). */
export function clearBoardSnapshot(): void {
  snapshot.clear();
}
