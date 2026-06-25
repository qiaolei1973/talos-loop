import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { execAsync } from "../../utils/execAsync.js";
import type {
  IssueSourcePlugin,
  ProjectContext,
  RepoRef,
  RawIssue,
  IssueStatus,
  IssueState,
  StatusTransition,
} from "../../types/plugin.js";

/**
 * The permanent eligibility marker an issue carries to be picked up by
 * talos-loop (set during PRD authoring; never modified by talos-loop). May be
 * overridden via project `config`. Core never reads it — it lives entirely in
 * the plugin. (The `skipped` label and the skip action were removed in issue #32.)
 */
const DEFAULT_TRIGGER = "ready-for-agent";

/** Per-project cached metadata resolved once from the GitHub Projects API. */
interface ProjectMeta {
  projectNodeId: string;             // PVT_xxx
  statusFieldId: string;             // PVTSSF_xxx (the "Status" single-select field)
  options: Map<string, string>;      // normalized option name → option id
}

interface GitHubConfig {
  triggerLabel?: string;
}

/** Resolve the trigger label from config (default applies). */
function resolveTrigger(ctx: ProjectContext): string {
  return ((ctx.config ?? {}) as GitHubConfig).triggerLabel ?? DEFAULT_TRIGGER;
}

interface GhItem {
  id: string;                  // PVTI_xxx item node id
  status: string;              // option name (e.g. "Ready", "In progress", "In review")
  content: {
    number: number;
    title: string;
    url: string;
    repository: string;        // "owner/repo"
    type: string;
  } | null;
}

/** Normalize a project status name for tolerant matching: "In progress" → "inprogress". */
function norm(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/** Parse "owner/number" → { owner, number }. Throws on malformed input. */
function parseProjectId(projectId: string): { owner: string; number: number } {
  const m = projectId.match(/^([^/]+)\/(\d+)$/);
  if (!m) throw new Error(`Invalid projectId "${projectId}" — expected "owner/number" (e.g. "qiaolei1973/1")`);
  return { owner: m[1], number: parseInt(m[2], 10) };
}

/** Split an "owner/repo" remote into its parts (validated to a shell/GraphQL-safe shape). */
function parseRemote(remote: string): { owner: string; repo: string } {
  const m = remote.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`Invalid remote "${remote}" — expected "owner/repo"`);
  return { owner: m[1], repo: m[2] };
}

/** Map a GitHub Projects status option name to a standard core state. */
function statusNameToState(name: string): IssueState | null {
  switch (norm(name)) {
    case "ready": return "ready";
    case "inprogress": return "inprogress";
    case "inreview": return "inreview";
    default: return null; // Backlog / Done(terminal) / unknown — not an active pipeline state
  }
}

/** Map a core state to the GitHub Projects status option name. */
function stateToStatusName(state: IssueState): string {
  switch (state) {
    case "ready": return "Ready";
    case "inprogress": return "In progress";
    case "inreview": return "In review";
  }
}

/** Marker embedded in config-drift comments so we don't spam an issue every poll. */
const DRIFT_MARKER = "talos-loop config-drift";

export class GitHubIssueSourcePlugin implements IssueSourcePlugin {
  name = "github";

  /** Per-project cache keyed by projectId. The plugin is a singleton (one per type). */
  private cache = new Map<string, ProjectMeta>();

  /** Active-board cache per project so list() shares one item-list per poll cycle. */
  private boardCache = new Map<string, { items: GhItem[]; at: number }>();
  private static readonly BOARD_CACHE_TTL_MS = 10_000;

  /**
   * Return every active, eligible issue with its standard `state` and, for
   * in-review (done) issues, a `review` subIssue when the linked PR has an
   * unresolved review thread. This single read replaces the old discover() +
   * listBoard() pair (issue #32): the server routes dispatch by `state`, and
   * the poller rebuilds the dashboard board snapshot from these states.
   *
   * Read failures THROW (issue #13) so the poller surfaces "board read failed"
   * rather than mistaking it for an empty board. A review-thread probe failure
   * is NOT a board-read failure — it is swallowed (the issue is returned without
   * a review subIssue this cycle, i.e. treated as "no review work"), so a
   * transient GraphQL hiccup never breaks polling.
   */
  async list(ctx: ProjectContext): Promise<RawIssue[]> {
    const items = await this.readBoard(ctx); // throws on read failure (no silent empty)
    const results: RawIssue[] = [];

    for (const item of items) {
      if (!item.content) continue;
      const state = statusNameToState(item.status ?? "");
      if (!state) continue; // terminal / unknown column — not active

      const remote = item.content.repository;
      const repo = ctx.repos.find((r) => r.remote === remote);
      if (!repo) {
        // Config drift: the issue's repo isn't declared in projects.json.
        ctx.logger.warn(
          `Issue #${item.content.number} (${remote}) is in project ${ctx.projectId} but its repo is not declared in projects.json — ignoring`,
        );
        await this.commentIfMissing(remote, item.content.number, ctx);
        continue;
      }

      const raw: RawIssue = {
        sourceId: String(item.content.number),
        url: item.content.url,
        title: item.content.title,
        targetRepo: repo.name,
        state,
      };

      // An in-review issue: signal unresolved review work so the server can
      // dispatch the review skill. The probe is best-effort (see method doc).
      if (state === "inreview") {
        const hasUnresolved = await this.hasUnresolvedReviewThread(ctx, remote, item.content.number);
        if (hasUnresolved) raw.subIssues = [{ type: "review", resolved: false }];
      }

      results.push(raw);
    }

    ctx.logger.info(`${ctx.projectId}: listed ${results.length} active issue(s)`);
    return results;
  }

  async getItem(ctx: ProjectContext, sourceId: string, targetRepo: string): Promise<IssueStatus> {
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) return { state: null };
    const trigger = resolveTrigger(ctx);
    try {
      const { stdout } = await execAsync(
        `gh issue view ${sourceId} --repo ${repo.remote} --json labels`,
        { timeout: 15_000 },
      );
      const data = JSON.parse(stdout);
      const labels: string[] = (data.labels ?? []).map((l: { name: string }) => l.name);
      // Actionable iff it still carries the eligibility marker.
      if (labels.includes(trigger)) return { state: "ready" };
      return { state: null };
    } catch (err: any) {
      ctx.logger.warn(`getItem: issue read failed for ${repo.remote}#${sourceId} — treating as not actionable: ${err.message}`);
      return { state: null };
    }
  }

  /**
   * Advance the stage by editing the project item's Status single-select. The
   * server only initiates queued→processing (dispatch) and processing→done
   * (clean exit detected via sentinel). Reads the board to find the item node
   * id — a read failure warns and bails (no edit attempted).
   */
  async writeLabel(ctx: ProjectContext, sourceId: string, transition: StatusTransition, targetRepo: string): Promise<void> {
    const meta = await this.ensureCache(ctx);
    const { owner, number } = parseProjectId(ctx.projectId);
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) {
      ctx.logger.error(`writeLabel: repo "${targetRepo}" has no remote`);
      return;
    }

    const optionId = meta.options.get(norm(stateToStatusName(transition.to)));
    if (!optionId) {
      ctx.logger.error(`writeLabel: no project option maps to state "${transition.to}"`);
      return;
    }

    let item: GhItem | undefined;
    try {
      item = await this.findItem(owner, number, sourceId, repo.remote);
    } catch (err: any) {
      ctx.logger.warn(`writeLabel: board read failed for ${repo.remote}#${sourceId} — cannot transition: ${err.message}`);
      return;
    }
    if (!item) {
      ctx.logger.error(`writeLabel: project item for ${repo.remote}#${sourceId} not found on board`);
      return;
    }

    try {
      await execAsync(
        `gh project item-edit --id ${item.id} --field-id ${meta.statusFieldId} --project-id ${meta.projectNodeId} --single-select-option-id ${optionId}`,
        { timeout: 15_000 },
      );
    } catch (err: any) {
      ctx.logger.error(`writeLabel failed for ${repo.remote}#${sourceId}: ${err.message}`);
    }
  }

  async writeComment(ctx: ProjectContext, sourceId: string, comment: string, targetRepo: string): Promise<void> {
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) {
      ctx.logger.error(`writeComment: repo "${targetRepo}" has no remote`);
      return;
    }
    try {
      const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
      await fsp.writeFile(tmpFile, comment, "utf-8");
      await execAsync(`gh issue comment ${sourceId} --repo ${repo.remote} --body-file "${tmpFile}"`, {
        timeout: 15_000,
      });
      await fsp.unlink(tmpFile);
    } catch (err: any) {
      ctx.logger.error(`Failed to comment on ${repo.remote}#${sourceId}: ${err.message}`);
    }
  }

  // --- internals ---

  /**
   * Does the open PR cross-referencing this issue have any unresolved review
   * thread? Drives the `review` subIssue signal in list(). Single GraphQL call
   * over the issue's cross-reference timeline. Fault-tolerant: any failure
   * (network, malformed, no linked PR) returns false — the issue is then treated
   * as having no review work this cycle, and the next poll retries the probe.
   */
  private async hasUnresolvedReviewThread(ctx: ProjectContext, remote: string, issueNumber: number): Promise<boolean> {
    let owner: string;
    let repo: string;
    try {
      ({ owner, repo } = parseRemote(remote));
    } catch {
      return false;
    }
    // Cross-referenced PRs that touch this issue; walk each PR's review threads.
    const query = `query{repository(owner:"${owner}",name:"${repo}"){issue(number:${issueNumber}){timelineItems(first:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...on PullRequest{reviewThreads(first:100){nodes{isResolved}}}}}}}}}}`;
    let raw: string;
    try {
      const { stdout } = await execAsync(`gh api graphql -f query='${query}'`, { timeout: 30_000 });
      raw = stdout;
    } catch (err: any) {
      ctx.logger.warn(`review probe failed for ${remote}#${issueNumber}: ${err.message}`);
      return false;
    }
    const nodes =
      (JSON.parse(raw) as { data?: { repository?: { issue?: { timelineItems?: { nodes?: Array<{ source?: { reviewThreads?: { nodes?: Array<{ isResolved?: boolean }> } } }> } } } } })?.data?.repository?.issue?.timelineItems?.nodes ?? [];
    for (const node of nodes) {
      const threads = node.source?.reviewThreads?.nodes ?? [];
      if (threads.some((t) => t.isResolved === false)) return true;
    }
    return false;
  }

  /** Resolve (and cache) project metadata: node id, status field id, option ids. */
  private async ensureCache(ctx: ProjectContext): Promise<ProjectMeta> {
    const existing = this.cache.get(ctx.projectId);
    if (existing) return existing;

    const { owner, number } = parseProjectId(ctx.projectId);

    const { stdout: projectRaw } = await execAsync(`gh project view ${number} --owner ${owner} --format json`, {
      timeout: 15_000,
    });
    const projectNodeId = (JSON.parse(projectRaw) as { id?: string }).id;
    if (!projectNodeId) throw new Error(`Could not resolve project node id for ${ctx.projectId}`);

    const { stdout: fieldRaw } = await execAsync(`gh project field-list ${number} --owner ${owner} --format json`, {
      timeout: 15_000,
    });
    const fields = (JSON.parse(fieldRaw) as { fields: Array<{ id: string; name: string; type: string; options?: Array<{ id: string; name: string }> }> }).fields;
    const statusField = fields.find((f) => f.name === "Status" && f.type === "ProjectV2SingleSelectField" && Array.isArray(f.options));
    if (!statusField || !statusField.options) throw new Error(`Status single-select field not found in project ${ctx.projectId}`);

    const options = new Map<string, string>();
    for (const opt of statusField.options) {
      options.set(norm(opt.name), opt.id);
    }

    const meta: ProjectMeta = { projectNodeId, statusFieldId: statusField.id, options };
    this.cache.set(ctx.projectId, meta);
    return meta;
  }

  /**
   * Read the active board — eligible (trigger label), non-terminal — once per
   * poll cycle, cached so list() (and the dashboard snapshot) share a single
   * `gh project item-list`. Status uses exclusion form: repeating a
   * single-select `status:` qualifier is AND (not OR), so the active set is
   * expressed by negating the terminal columns Backlog/Done. Throws on read
   * failure (issue #13) so callers distinguish empty from broken.
   */
  private async readBoard(ctx: ProjectContext): Promise<GhItem[]> {
    const cached = this.boardCache.get(ctx.projectId);
    if (cached && Date.now() - cached.at < GitHubIssueSourcePlugin.BOARD_CACHE_TTL_MS) {
      return cached.items;
    }
    const { owner, number } = parseProjectId(ctx.projectId);
    const trigger = resolveTrigger(ctx);
    const items = await this.ghItemList(owner, number, `label:${trigger} -status:Backlog -status:Done`);
    this.boardCache.set(ctx.projectId, { items, at: Date.now() });
    return items;
  }

  /**
   * Read the project item-list. Throws on read failure (issue #13) instead of
   * silently returning [] — callers then distinguish a real empty board from an
   * unreadable one, so a transient gh outage is surfaced rather than
   * masquerading as "no items".
   */
  private async ghItemList(owner: string, number: number, query?: string): Promise<GhItem[]> {
    const q = query ? ` --query "${query}"` : "";
    const { stdout } = await execAsync(
      `gh project item-list ${number} --owner ${owner} --format json --limit 100${q}`,
      { timeout: 30_000 },
    );
    return (JSON.parse(stdout) as { items?: GhItem[] }).items ?? [];
  }

  private async findItem(owner: string, number: number, sourceId: string, remote: string): Promise<GhItem | undefined> {
    const items = await this.ghItemList(owner, number);
    return items.find(
      (it) => it.content && String(it.content.number) === String(sourceId) && it.content.repository === remote,
    );
  }

  private repoByName(ctx: ProjectContext, targetRepo: string): RepoRef | undefined {
    return ctx.repos.find((r) => r.name === targetRepo);
  }

  /** Post a one-time config-drift comment so we don't spam the issue every poll cycle. */
  private async commentIfMissing(remote: string, issueNumber: number, ctx: ProjectContext): Promise<void> {
    try {
      const { stdout } = await execAsync(`gh issue view ${issueNumber} --repo ${remote} --json comments`, {
        timeout: 15_000,
      });
      const comments = (JSON.parse(stdout) as { comments?: Array<{ body?: string }> }).comments ?? [];
      if (comments.some((c) => c.body?.includes(DRIFT_MARKER))) return; // already notified
    } catch {
      // proceed to attempt the comment anyway
    }
    try {
      const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
      await fsp.writeFile(
        tmpFile,
        `<!-- ${DRIFT_MARKER} -->\n⚠️ This issue's repository \`${remote}\` is not declared in talos-loop's \`projects.json\`, so it will not be processed. Add the repo to the relevant project entry to enable it.`,
        "utf-8",
      );
      await execAsync(`gh issue comment ${issueNumber} --repo ${remote} --body-file "${tmpFile}"`, {
        timeout: 15_000,
      });
      await fsp.unlink(tmpFile);
    } catch (err: any) {
      ctx.logger.error(`Failed to post config-drift comment on ${remote}#${issueNumber}: ${err.message}`);
    }
  }
}
