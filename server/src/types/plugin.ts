import type { Logger } from "../services/logger.js";

/**
 * Standard issue-state contract between talos-loop core and issue-source plugins.
 *
 * Plugins translate between these abstract states and their own source-specific
 * mechanism (GitHub Projects columns, Jira transitions, Linear statuses, ...).
 * Core speaks ONLY in these states and never reads source-specific config
 * (e.g. project column names) beyond the base fields `projectType` and `enabled`.
 *
 * NOTE: there is no "failed" state. The state machine is driven by the GitHub
 * Projects board:
 *
 *     Ready(queued) → In progress(processing) → In review(done)
 *
 * Infrastructure failures (LLM token exhaustion, network errors) and agent
 * self-skips both return the issue to `queued` (Ready); the failure detail is
 * recorded on the session row only and surfaced in the dashboard. GitHub's own
 * project automation advances "In review" → "Done" on PR merge — that terminal
 * column is NOT represented here because talos-loop never drives it.
 *
 * ⚠️ Naming trap: the `done` state corresponds to GitHub's **"In review"**
 * column (PR created), NOT the terminal "Done" column.
 */
export type IssueState = "queued" | "processing" | "done";

/**
 * A single named parameter of a plugin action, surfaced to the agent in the
 * prompt so it knows which body fields to send. `description` is for future
 * tooling; the prompt renders only the `name`s.
 */
export interface PluginCapabilityParam {
  name: string;
  description: string;
}

/**
 * A self-described action a plugin exposes to the agent. The unified
 * `/actions/:action` route dispatches by `action`; `buildPrompt` renders the
 * full list so the prompt stays in sync with what the plugin supports without
 * any dispatcher changes. `params` are the JSON body fields beyond the shared
 * `targetRepo`.
 */
export interface PluginCapability {
  /** Route segment under /actions/:action, e.g. "submit-pr", "comment", "skip". */
  action: string;
  /** Human-readable summary shown in the agent prompt. */
  description: string;
  params: PluginCapabilityParam[];
}

export interface IssueSourcePlugin {
  /** Display name / alias. Shown in logs and the UI. The package name (config `projectType`) is only used to load the plugin. */
  name: string;
  init(ctx: ProjectContext): Promise<void>;
  /**
   * Return actionable issues — those ready to dispatch. Each carries its
   * standard `state`, which (for a project-board-driven source) is always
   * `queued`. In-flight issues are tracked by the core's session table, not
   * re-discovered, so plugins need not return them.
   */
  discover(ctx: ProjectContext): Promise<RawIssue[]>;
  /**
   * List every item on the project board with its current column. Used by the
   * poller to refresh the in-memory board snapshot — the input to display-status
   * derivation (issue #13). Unlike discover(), this returns ALL items (not just
   * Ready) so the dashboard can show processing / done / merged issues. Read
   * failures must THROW (not return an empty array) so the poller can surface
   * them as a prominent "board read failed" warning instead of silently treating
   * the board as empty.
   */
  listBoard(ctx: ProjectContext): Promise<BoardItem[]>;
  /**
   * Current state of a single issue, used for the pre-dispatch freshness check.
   * Returns `null` when the issue is not actionable (e.g. no longer in Ready,
   * or the issue was closed).
   */
  getStatus(ctx: ProjectContext, sourceId: string, targetRepo: string): Promise<IssueStatus>;
  /**
   * Command the plugin to move an issue from one standard state to another.
   * Core only ever initiates legal transitions of the state machine:
   * queued→processing (dispatch), processing→done (PR created),
   * processing→queued (infrastructure failure or skip — return to Ready).
   * `from` is provided for context but project-board `item-edit` sets an
   * absolute value, so plugins may ignore it.
   */
  transition(ctx: ProjectContext, sourceId: string, transition: StatusTransition, targetRepo: string): Promise<void>;
  test(ctx: ProjectContext): Promise<boolean>;
  /**
   * Post a comment on the issue. `targetRepo` selects which repository the
   * issue lives in (a project may span multiple repos).
   */
  onComment?(ctx: ProjectContext, sourceId: string, comment: string, targetRepo: string): Promise<void>;
  /**
   * Declare the actions this plugin exposes to the agent. The unified
   * `/actions/:action` route dispatches by the capability `action`, and
   * `buildPrompt` renders this list verbatim. Intentionally static (no context):
   * action URLs follow a fixed pattern derivable from projectId/sourceId, so the
   * plugin only describes *what* it can do, not *where*. Omit if the plugin has
   * no agent-facing actions.
   */
  capabilities?(): PluginCapability[];
  /**
   * Create a pull request for `branch` against the project's target branch and
   * return its URL. Single responsibility: create the PR and return the URL —
   * all session finalization (transition, comment, DB updates) stays in the
   * dispatcher/route layer. Invoked via the `submit-pr` action.
   */
  submitPr?(ctx: ProjectContext, sourceId: string, branch: string, targetRepo: string): Promise<string>;
  /**
   * The agent has determined it cannot complete the task (insufficient
   * requirements, wrong repo, ...). The plugin should make this durable and
   * blocking: apply its skip marker (e.g. a `skipped` label), post a comment
   * with the reason, and move the project status back to `queued` (Ready) so
   * the board reflects the parked state. The issue is then excluded from
   * `discover()` until a human removes the skip marker.
   */
  skip(ctx: ProjectContext, sourceId: string, targetRepo: string, reason: string): Promise<void>;
}

/**
 * Reference to a code repository injected into plugin context. Resolved from a
 * project's `repos[]` entry. `name` is the basename of the local path and
 * doubles as the DB `target_repo` key (and dashboard grouping); `remote` is the
 * upstream "owner/repo" (inferred from `git remote`, overridable) and may be
 * undefined when inference fails and no override is given.
 */
export interface RepoRef {
  name: string;
  path: string;
  remote?: string;
}

export interface ProjectContext {
  config: Record<string, unknown>;
  logger: Logger;
  /** All repos declared for this project (a project may span multiple repos). */
  repos: RepoRef[];
  /**
   * Project identifier as configured in projects.json, e.g. "owner/number".
   * Plugins need this to query their project (GitHub Projects board) and to key
   * per-project cached metadata on the (singleton) plugin instance. This field
   * extends the minimal {config, logger, repos} interface declared in the spec.
   */
  projectId: string;
}

export interface RawIssue {
  sourceId: string;
  url: string;
  title: string;
  targetRepo: string;
  /** Standard state of this issue at discovery time (queued for a board-driven source). */
  state: IssueState;
}

/**
 * A single item on the project board, as read for display-status derivation. The
 * board is the single source of workflow truth (issue #13): the poller reads the
 * full board each cycle into an in-memory snapshot, and the display layer maps
 * the source-specific `boardStatus` column name to a standard display state.
 */
export interface BoardItem {
  sourceId: string;
  /** "owner/repo" — matched against declared repos (config-drift items are skipped). */
  repository: string;
  /** Raw board column name, e.g. "Ready", "In progress", "In review", "Done". */
  boardStatus: string;
  url: string;
  title: string;
}

export interface IssueStatus {
  /** `null` when the issue is not in any pipeline state. */
  state: IssueState | null;
}

export interface StatusTransition {
  from: IssueState;
  to: IssueState;
}
