import type { Logger } from "../services/logger.js";

/**
 * Standard issue-state contract between talos-loop core and issue-source plugins.
 *
 * Plugins translate between these abstract states and their own source-specific
 * mechanism (GitHub labels, Jira transitions, Linear statuses, ...). Core speaks
 * ONLY in these states and never reads source-specific config (e.g. label names)
 * beyond the base fields `type` and `enabled`.
 *
 * The four states mirror talos-loop's internal DB issue status one-to-one.
 */
export type IssueState = "queued" | "processing" | "done" | "failed";

export interface IssueSourcePlugin {
  /** Display name / alias. Shown in logs and the UI. The package name (config `type`) is only used to load the plugin. */
  name: string;
  init(ctx: SourceContext): Promise<void>;
  /**
   * Return actionable issues. Each carries its standard `state`, which can only
   * be `queued` or `processing`. Core buckets issues by this field and does NOT
   * call `getStatus` per issue to classify them.
   */
  discover(ctx: SourceContext): Promise<RawIssue[]>;
  /**
   * Current state of a single issue, used for the pre-dispatch freshness check.
   * Returns `null` when the issue is not in any pipeline state (e.g. markers
   * cleared externally, or the issue was closed).
   */
  getStatus(ctx: SourceContext, sourceId: string): Promise<IssueStatus>;
  /**
   * Command the plugin to move an issue from one standard state to another.
   * Core only ever initiates legal transitions of the state machine:
   * queued→processing, processing→done, processing→failed, failed→queued.
   * `from` is provided so plugins can perform precise remove semantics without
   * an extra round-trip.
   */
  transition(ctx: SourceContext, sourceId: string, transition: StatusTransition): Promise<void>;
  test(ctx: SourceContext): Promise<boolean>;
  onComment?(ctx: SourceContext, sourceId: string, comment: string): Promise<void>;
}

/**
 * Reference to a code repository injected into plugin context. Resolved from the
 * `source.repo` field against `repos.json`. `name` is the basename of the local
 * path and doubles as the DB `target_repo` key; `remote` is the upstream
 * "owner/repo" (inferred from `git remote`, overridable in repos.json) and may
 * be undefined when inference fails and no override is given.
 */
export interface RepoRef {
  name: string;
  path: string;
  remote?: string;
}

export interface SourceContext {
  config: Record<string, unknown>;
  logger: Logger;
  /** The repo this source is bound to (resolved from `source.repo`). */
  repo?: RepoRef;
}

export interface RawIssue {
  sourceId: string;
  url: string;
  title: string;
  targetRepo: string;
  /** Standard state of this issue as known at discovery time (queued or processing). */
  state: IssueState;
}

export interface IssueStatus {
  /** `null` when the issue is not in any pipeline state. */
  state: IssueState | null;
}

export interface StatusTransition {
  from: IssueState;
  to: IssueState;
}
