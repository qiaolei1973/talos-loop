import type { Logger } from "../services/logger.js";

/**
 * Standard issue-state contract between talos-loop core and issue-source plugins.
 *
 * Plugins translate between these abstract states and their own source-specific
 * mechanism (GitHub Projects columns, Jira transitions, Linear statuses, ...).
 * Core speaks ONLY in these states and never reads source-specific config
 * (e.g. project column names) beyond the base fields `projectType` and `enabled`.
 *
 * The state machine (issue #32) is driven entirely by the server reading the
 * tmux session's exit-code sentinel, then calling {@link IssueSourcePlugin.writeLabel}:
 *
 *     queued(Ready) ──dispatch──► processing(In progress)
 *                                  │
 *                          exit 0 ──┼──► done(In review) ──PR merge──► Done
 *                          crash   ──┘   (review subIssues → review skill; crash → claude -r retry)
 *
 * ⚠️ There is no `failed` state on the board: a crash that exhausts retries
 * leaves the issue `processing` (In progress) for a human, with a comment.
 * ⚠️ Naming trap: the `done` state corresponds to GitHub's **"In review"**
 * column (PR created), NOT the terminal "Done" column (advanced by GitHub's own
 * automation on PR merge — talos-loop never drives it).
 */
export type IssueState = "queued" | "processing" | "done";

/**
 * A minimal signal carried on a {@link RawIssue} that something downstream of
 * the issue needs attention. The server keys review-skill dispatch off a
 * `type: "review"` subIssue that is not yet `resolved`. It carries NO body/id —
 * the skill fetches the concrete content (review threads, …) from the platform
 * itself, so the source plugin only has to answer "is there unresolved work?".
 */
export interface SubIssue {
  type: "review" | "subissue";
  resolved: boolean;
}

/**
 * The source-plugin contract (issue #32). A plugin is a **read + lightweight
 * write** adapter over ONE issue source: it discovers issues (with their stage
 * and any sub-issue signals) and advances their stage. It does NOT execute
 * agent actions — PRs, review-thread resolution, etc. are the skill's job, and
 * the agent never calls back into the server.
 *
 *   list()       required — every active issue + its standard state + subIssues
 *   getItem?()   optional — single-issue freshness recheck; defaults to the
 *                            state already in the list() result
 *   writeLabel() required — advance the stage (queued/processing/done)
 *   writeComment?() optional — post on the issue; absent ⇒ server skips silently
 */
export interface IssueSourcePlugin {
  /** Display name / alias. Shown in logs and the UI. */
  name: string;
  /**
   * Return every ACTIVE issue on the source (not just Ready) with its standard
   * `state` and any `subIssues`. The server routes each issue by state: `queued`
   * → ready-stage skill dispatch, `done` with an unresolved `review` subIssue →
   * review-stage skill dispatch. In-flight issues are also tracked by the
   * sessions table; this is the single read that feeds both dispatch and the
   * dashboard board snapshot. Read failures MUST THROW (not return []) so the
   * poller can surface "board read failed" instead of mistaking it for empty.
   */
  list(ctx: ProjectContext): Promise<RawIssue[]>;
  /**
   * Current state of a single issue, for the pre-dispatch freshness recheck.
   * Returns `null` when the issue is no longer actionable. Optional: when
   * omitted, the server trusts the fresh `state` from the last list() result.
   */
  getItem?(ctx: ProjectContext, sourceId: string, targetRepo: string): Promise<IssueStatus>;
  /**
   * Advance an issue from one standard state to another. The server only ever
   * initiates legal transitions: queued→processing (dispatch) and
   * processing→done (clean exit detected via sentinel). `from` is provided for
   * context but project-board `item-edit` sets an absolute value, so plugins may
   * ignore it.
   */
  writeLabel(ctx: ProjectContext, sourceId: string, transition: StatusTransition, targetRepo: string): Promise<void>;
  /**
   * Post a comment on the issue. Called by the server after a coding session
   * crashes and exhausts retries (so a human sees why the issue is parked).
   * Optional: when omitted, the server silently skips the comment.
   */
  writeComment?(ctx: ProjectContext, sourceId: string, comment: string, targetRepo: string): Promise<void>;
  /**
   * Declare settings this plugin needs. Required fields block dispatch until
   * configured (future enforcement); optional fields are always shown in the UI.
   *
   * Keys are scoped to the plugin — the stored key becomes
   * `{pluginName}.{key}` (e.g. "dima.dima-token"). Plugins that don't implement
   * this simply show no settings in the UI.
   */
  schema?(): PluginSchema;
}

/**
 * Reference to a code repository injected into plugin context. Resolved from a
 * project's `repos[]` entry. `name` is the basename of the local path and
 * doubles as the DB `target_repo` key (and dashboard grouping); `remote` is the
 * upstream "owner/repo" (inferred from `git remote`, overridable) and may be
 * undefined when inference fails and no override is given.
 *
 * `branch` is the repo's baseline (integration) branch — the line the feat
 * branch is cut from as `origin/<branch>`. Defaults to "main" at the consumer
 * when unset, since different repos use master/develop/etc.
 */
export interface RepoRef {
  name: string;
  path: string;
  remote?: string;
  /**
   * Baseline integration branch (e.g. "main", "master", "develop"). The feat
   * branch is created from `origin/<branch>`; consumers default to "main" when
   * this is unset.
   */
  branch?: string;
}

export interface ProjectContext {
  config: Record<string, unknown>;
  logger: Logger;
  /** All repos declared for this project (a project may span multiple repos). */
  repos: RepoRef[];
  /**
   * Project identifier as configured in projects.json, e.g. "owner/number".
   * Plugins need this to query their project (GitHub Projects board) and to key
   * per-project cached metadata on the (singleton) plugin instance.
   */
  projectId: string;
}

export interface RawIssue {
  sourceId: string;
  url: string;
  title: string;
  targetRepo: string;
  /** Standard state of this issue as read from the source (queued/processing/done). */
  state: IssueState;
  /** Downstream attention signals — e.g. an unresolved review thread on the PR. */
  subIssues?: SubIssue[];
}

export interface IssueStatus {
  /** `null` when the issue is not in any pipeline state. */
  state: IssueState | null;
}

export interface StatusTransition {
  from: IssueState;
  to: IssueState;
}

// ---------------------------------------------------------------------------
// Settings — plugin-declared configuration parameters managed via GUI
// ---------------------------------------------------------------------------

/** A setting that a plugin declares it needs. Stored in the `settings` table
 *  under a scoped key `{pluginName}.{key}` (e.g. "dima.dima-token").
 *  The `schema()` return value drives the Settings UI form fields. */
export interface SettingDef {
  key: string;         // machine key, scoped to the plugin (e.g. "dima-token")
  label: string;       // human label (e.g. "Dima Token")
  description: string; // explanatory text shown below the label
}

/** A complete plugin settings schema — required fields block dispatch
 *  until configured (future enforcement); optional fields are always shown. */
export interface PluginSchema {
  required: SettingDef[];
  optional: SettingDef[];
}
