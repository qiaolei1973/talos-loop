import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  IssueSourcePlugin,
  ProjectContext,
  RepoRef,
  RawIssue,
  BoardItem,
  IssueStatus,
  IssueState,
  StatusTransition,
  PluginCapability,
  QuotaStatus,
  ReviewThread,
} from "../../types/plugin.js";

/**
 * Default label vocabulary. `ready-for-agent` is a permanent eligibility
 * marker set during PRD authoring (never modified by talos-loop); `skipped`
 * is the durable skip marker the plugin applies. Both may be overridden via
 * project `config`. Core never reads these — they live entirely in the plugin.
 */
const DEFAULT_TRIGGER = "ready-for-agent";
const DEFAULT_SKIP = "skipped";

/** Per-project cached metadata resolved once from the GitHub Projects API. */
interface ProjectMeta {
  projectNodeId: string;             // PVT_xxx
  statusFieldId: string;             // PVTSSF_xxx (the "Status" single-select field)
  options: Map<string, string>;      // normalized option name → option id
}

interface GitHubConfig {
  triggerLabel?: string;
  skipLabel?: string;
}

/** Resolve the trigger/skip labels from config (defaults apply). */
function resolveLabels(ctx: ProjectContext): { trigger: string; skip: string } {
  const c = (ctx.config ?? {}) as GitHubConfig;
  return {
    trigger: c.triggerLabel ?? DEFAULT_TRIGGER,
    skip: c.skipLabel ?? DEFAULT_SKIP,
  };
}

interface GhItem {
  id: string;                  // PVTI_xxx item node id
  status: string;              // option name (e.g. "Ready", "In progress")
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

/**
 * Parse a GitHub PR URL → { owner, repo, number } (issue #19). Accepts the plain
 * PR url (and tolerates a trailing path/query). owner/repo are validated to a
 * shell/GraphQL-safe shape since they are inlined into GraphQL literals.
 */
function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Invalid PR url "${prUrl}" — expected "https://github.com/owner/repo/pull/<number>"`);
  const owner = m[1];
  const repo = m[2];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid owner/repo in PR url "${prUrl}"`);
  }
  return { owner, repo, number: parseInt(m[3], 10) };
}

/** Map a core state to the GitHub Projects status option name. */
function stateToStatusName(state: IssueState): string {
  switch (state) {
    case "queued": return "Ready";
    case "processing": return "In progress";
    case "done": return "In review";
  }
}

/** Marker embedded in config-drift comments so we don't spam an issue every poll. */
const DRIFT_MARKER = "talos-loop config-drift";

export class GitHubIssueSourcePlugin implements IssueSourcePlugin {
  name = "github";

  /** Per-project cache keyed by projectId. The plugin is a singleton (one per type). */
  private cache = new Map<string, ProjectMeta>();

  /** Active-board cache per project so discover() + listBoard() share one item-list per poll cycle. */
  private boardCache = new Map<string, { items: GhItem[]; at: number }>();
  private static readonly BOARD_CACHE_TTL_MS = 10_000;

  /** Quota probe cache (token-wide): collapses concurrent per-project probes within one poll. */
  private quotaCache: { remaining: number; limit: number; reset: number; at: number } | null = null;
  private static readonly QUOTA_TTL_MS = 5_000;

  async init(ctx: ProjectContext): Promise<void> {
    this.ensureCache(ctx);

    const { skip } = resolveLabels(ctx);
    // Create the skipped label on every repo that has a resolvable remote.
    for (const repo of ctx.repos) {
      if (!repo.remote) {
        ctx.logger.warn(`Repo "${repo.name}" has no remote — cannot ensure "${skip}" label`);
        continue;
      }
      try {
        execSync(
          `gh label create "${skip}" --repo ${repo.remote} --color BFD4F2 --description "Agent skipped this issue" --force`,
          { timeout: 10_000, stdio: "pipe" },
        );
      } catch {
        // label likely already exists
      }
    }
    ctx.logger.info(`GitHub plugin initialized for project ${ctx.projectId}`);
  }

  async discover(ctx: ProjectContext): Promise<RawIssue[]> {
    try {
      this.ensureCache(ctx);
    } catch (err: any) {
      ctx.logger.error(`discover: failed to resolve project meta: ${err.message}`);
      return [];
    }

    // readBoard shares one item-list with listBoard() (cached this poll cycle) and
    // already narrows server-side to eligible, non-skipped, active items.
    const items = this.readBoard(ctx);
    const results: RawIssue[] = [];

    for (const item of items) {
      // Only Ready items are actionable; In progress / In review / Done are tracked
      // elsewhere (sessions table) and must not be re-dispatched.
      if (norm(item.status ?? "") !== "ready") continue;
      if (!item.content) continue;

      const remote = item.content.repository;
      const repo = ctx.repos.find((r) => r.remote === remote);
      if (!repo) {
        // Config drift: the issue's repo isn't declared in projects.json.
        ctx.logger.warn(
          `Issue #${item.content.number} (${remote}) is in project ${ctx.projectId} but its repo is not declared in projects.json — ignoring`,
        );
        this.commentIfMissing(remote, item.content.number, ctx);
        continue;
      }

      results.push({
        sourceId: String(item.content.number),
        url: item.content.url,
        title: item.content.title,
        targetRepo: repo.name,
        state: "queued",
      });
    }

    ctx.logger.info(`${ctx.projectId}: discovered ${results.length} ready issue(s)`);
    return results;
  }

  async listBoard(ctx: ProjectContext): Promise<BoardItem[]> {
    try {
      this.ensureCache(ctx);
    } catch (err: any) {
      ctx.logger.error(`listBoard: failed to resolve project meta: ${err.message}`);
      return [];
    }
    // readBoard shares one item-list with discover() (cached this poll cycle) and
    // returns only the active, eligible set. It throws on read failure (issue #13:
    // no silent empty) — the poller surfaces it as a "board read failed" warning.
    const items = this.readBoard(ctx);
    const results: BoardItem[] = [];
    for (const item of items) {
      if (!item.content) continue;
      results.push({
        sourceId: String(item.content.number),
        repository: item.content.repository,
        boardStatus: item.status ?? "",
        url: item.content.url,
        title: item.content.title,
      });
    }
    return results;
  }

  async checkQuota(_ctx: ProjectContext): Promise<QuotaStatus> {
    const now = Date.now();
    const cached = this.quotaCache;
    if (cached && now - cached.at < GitHubIssueSourcePlugin.QUOTA_TTL_MS) {
      return { available: true, remaining: cached.remaining, limit: cached.limit, resetAt: new Date(cached.reset * 1000) };
    }
    try {
      // `gh api rate_limit` is a free probe (costs neither REST nor GraphQL quota)
      // and reports both budgets. talos-loop only burns GraphQL, so that is what
      // we surface for the poller's skip decision.
      const raw = execSync("gh api rate_limit", { encoding: "utf-8", timeout: 10_000, stdio: "pipe" });
      const graphql = (JSON.parse(raw) as { resources?: { graphql?: { remaining?: number; limit?: number; reset?: number } } }).resources?.graphql;
      if (!graphql) return { available: false, error: "rate_limit response missing graphql resource" };
      this.quotaCache = { remaining: graphql.remaining ?? 0, limit: graphql.limit ?? 0, reset: graphql.reset ?? 0, at: now };
      return { available: true, remaining: this.quotaCache.remaining, limit: this.quotaCache.limit, resetAt: new Date(this.quotaCache.reset * 1000) };
    } catch (err: any) {
      // A probe failure must never block polling — surface it and let the caller
      // fall through to a normal (possibly rate-limited) board read.
      return { available: false, error: err.message };
    }
  }

  async getStatus(ctx: ProjectContext, sourceId: string, targetRepo: string): Promise<IssueStatus> {
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) return { state: null };
    const { trigger, skip } = resolveLabels(ctx);
    try {
      const raw = execSync(
        `gh issue view ${sourceId} --repo ${repo.remote} --json labels`,
        { encoding: "utf-8", timeout: 15_000, stdio: "pipe" },
      );
      const data = JSON.parse(raw);
      const labels: string[] = (data.labels ?? []).map((l: { name: string }) => l.name);
      // Actionable iff it still carries the eligibility marker and has not been skipped.
      if (labels.includes(trigger) && !labels.includes(skip)) return { state: "queued" };
      return { state: null };
    } catch (err: any) {
      // Distinguish a real read failure from a genuinely-not-actionable issue
      // (issue #13): surface it prominently rather than silently masquerading as
      // "not actionable". Behavior is unchanged (treated as not queued) so a
      // transient gh outage doesn't dispatch stale issues.
      ctx.logger.warn(`getStatus: issue read failed for ${repo.remote}#${sourceId} — treating as not actionable: ${err.message}`);
      return { state: null };
    }
  }

  async test(_ctx: ProjectContext): Promise<boolean> {
    try {
      execSync("gh auth status", { timeout: 10_000, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async transition(ctx: ProjectContext, sourceId: string, transition: StatusTransition, targetRepo: string): Promise<void> {
    const meta = this.ensureCache(ctx);
    const { owner, number } = parseProjectId(ctx.projectId);
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) {
      ctx.logger.error(`transition: repo "${targetRepo}" has no remote`);
      return;
    }

    const optionId = meta.options.get(norm(stateToStatusName(transition.to)));
    if (!optionId) {
      ctx.logger.error(`transition: no project option maps to state "${transition.to}"`);
      return;
    }

    // findItem reads the board via ghItemList, which throws on read failure
    // (issue #13). Distinguish that transient failure from a genuinely-absent
    // item: a read failure warns and bails; an absent item errors and bails.
    let item: GhItem | undefined;
    try {
      item = this.findItem(owner, number, sourceId, repo.remote);
    } catch (err: any) {
      ctx.logger.warn(`transition: board read failed for ${repo.remote}#${sourceId} — cannot transition: ${err.message}`);
      return;
    }
    if (!item) {
      ctx.logger.error(`transition: project item for ${repo.remote}#${sourceId} not found on board`);
      return;
    }

    try {
      execSync(
        `gh project item-edit --id ${item.id} --field-id ${meta.statusFieldId} --project-id ${meta.projectNodeId} --single-select-option-id ${optionId}`,
        { timeout: 15_000, stdio: "pipe" },
      );
    } catch (err: any) {
      ctx.logger.error(`transition failed for ${repo.remote}#${sourceId}: ${err.message}`);
    }
  }

  async onComment(ctx: ProjectContext, sourceId: string, comment: string, targetRepo: string): Promise<void> {
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) {
      ctx.logger.error(`onComment: repo "${targetRepo}" has no remote`);
      return;
    }
    try {
      const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, comment, "utf-8");
      execSync(`gh issue comment ${sourceId} --repo ${repo.remote} --body-file "${tmpFile}"`, {
        timeout: 15_000,
        stdio: "pipe",
      });
      fs.unlinkSync(tmpFile);
    } catch (err: any) {
      ctx.logger.error(`Failed to comment on ${repo.remote}#${sourceId}: ${err.message}`);
    }
  }

  async skip(ctx: ProjectContext, sourceId: string, targetRepo: string, reason: string): Promise<void> {
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) {
      ctx.logger.error(`skip: repo "${targetRepo}" has no remote`);
      return;
    }
    const { skip: skipLabel } = resolveLabels(ctx);

    try {
      execSync(`gh issue edit ${sourceId} --repo ${repo.remote} --add-label "${skipLabel}"`, {
        timeout: 15_000,
        stdio: "pipe",
      });
    } catch (err: any) {
      ctx.logger.error(`skip: failed to add "${skipLabel}" label on ${repo.remote}#${sourceId}: ${err.message}`);
    }

    if (this.onComment) {
      await this.onComment(ctx, sourceId, `⏭️ Agent skipped this issue.\n\nReason: ${reason}`, targetRepo);
    }

    // Return the board status to Ready (the issue stays parked via the skip label).
    await this.transition(ctx, sourceId, { from: "processing", to: "queued" }, targetRepo);
  }

  capabilities(): PluginCapability[] {
    return [
      { action: "submit-pr", description: "完成编码后提交 PR", params: [{ name: "branch", description: "PR 源分支名" }] },
      { action: "comment", description: "在工作项留言", params: [{ name: "message", description: "留言内容" }] },
      { action: "skip", description: "放弃任务", params: [{ name: "reason", description: "跳过原因" }] },
      // resolve-thread (issue #19): the review-fix agent calls this after
      // addressing each thread so GitHub's native thread state is the single
      // source of truth. `threadId` is the review-thread node id from
      // listUnresolvedThreads(); `prUrl` identifies the PR (the agent knows both
      // from its prompt).
      { action: "resolve-thread", description: "解决 PR 评审线程（修复后调用）", params: [{ name: "threadId", description: "评审线程节点 id" }, { name: "prUrl", description: "PR 地址" }] },
    ];
  }

  async submitPr(ctx: ProjectContext, sourceId: string, branch: string, targetRepo: string): Promise<string> {
    const repo = this.repoByName(ctx, targetRepo);
    if (!repo?.remote) {
      throw new Error(`submitPr: repo "${targetRepo}" has no remote`);
    }
    // Single responsibility: create the PR and return its URL. The dispatcher
    // performs session finalization (transition, comment, status) once it reads
    // this URL back from the stored session.
    const title = `Closes #${sourceId}`;
    const raw = execSync(
      `gh pr create --head ${branch} --base main --title "${title}" --repo ${repo.remote} --json url`,
      { encoding: "utf-8", timeout: 30_000, stdio: "pipe" },
    );
    const url = (JSON.parse(raw) as { url?: string }).url;
    if (!url) throw new Error(`submitPr: could not parse PR URL from gh output for ${repo.remote}#${sourceId}`);
    ctx.logger.info(`Created PR for ${repo.remote}#${sourceId} from branch ${branch}: ${url}`);
    return url;
  }

  /**
   * Unresolved review threads on a PR (issue #19). GitHub's GraphQL is the only
   * source — `gh pr view` does not expose the thread node id that
   * `resolveReviewThread` needs. A transient read failure returns [] (treated by
   * `dispatchReview()` as "no work, skip this cycle"); unresolved threads still
   * exist, so the next poll cycle retries.
   */
  async listUnresolvedThreads(ctx: ProjectContext, prUrl: string): Promise<ReviewThread[]> {
    const { owner, repo, number } = parsePrUrl(prUrl);
    // Inline the (validated) owner/repo/number as GraphQL literals. owner/repo
    // match ^[\w.-]+$ and number is an integer, so this is injection-safe and
    // avoids the GraphQL-Int-vs-String coercion pitfall of a `-F number=` arg.
    const query = `query{repository(owner:"${owner}",name:"${repo}"){pullRequest(number:${number}){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}`;
    let raw: string;
    try {
      raw = execSync(`gh api graphql -f query='${query}'`, { encoding: "utf-8", timeout: 30_000, stdio: "pipe" });
    } catch (err: any) {
      ctx.logger.warn(`listUnresolvedThreads: GraphQL read failed for ${owner}/${repo}#${number}: ${err.message}`);
      return [];
    }
    const threads =
      (JSON.parse(raw) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id: string; isResolved: boolean; path?: string; comments?: { nodes?: Array<{ body?: string }> } }> } } } } })?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return threads
      .filter((t) => !t.isResolved)
      .map((t) => ({
        id: String(t.id),
        body: t.comments?.nodes?.[0]?.body ?? "",
        path: t.path,
        resolved: false,
      }));
  }

  /**
   * Resolve one review thread via the GraphQL `resolveReviewThread` mutation
   * (issue #19). `threadId` is the review-thread node id. The id is validated to
   * a node-id shape (GitHub ids are base64-ish `[A-Za-z0-9_]+`) before inlining
   * into the mutation — it carries no shell or GraphQL quoting hazard once
   * validated. Errors propagate so the agent sees the failure.
   */
  async resolveThread(ctx: ProjectContext, _sourceId: string, prUrl: string, threadId: string): Promise<void> {
    if (!/^[\w]+$/.test(threadId)) throw new Error(`resolveThread: invalid thread id "${threadId}"`);
    parsePrUrl(prUrl); // validate the PR url shape (owner/repo/#)
    const mutation = `mutation{resolveReviewThread(input:{threadId:"${threadId}"}){thread{isResolved}}}`;
    try {
      execSync(`gh api graphql -f query='${mutation}'`, { encoding: "utf-8", timeout: 15_000, stdio: "pipe" });
    } catch (err: any) {
      ctx.logger.error(`resolveThread: failed to resolve thread ${threadId} on ${prUrl}: ${err.message}`);
      throw err;
    }
  }

  // --- internals ---

  /** Resolve (and cache) project metadata: node id, status field id, option ids. */
  private ensureCache(ctx: ProjectContext): ProjectMeta {
    const existing = this.cache.get(ctx.projectId);
    if (existing) return existing;

    const { owner, number } = parseProjectId(ctx.projectId);

    const projectRaw = execSync(`gh project view ${number} --owner ${owner} --format json`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: "pipe",
    });
    const projectNodeId = (JSON.parse(projectRaw) as { id?: string }).id;
    if (!projectNodeId) throw new Error(`Could not resolve project node id for ${ctx.projectId}`);

    const fieldRaw = execSync(`gh project field-list ${number} --owner ${owner} --format json`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: "pipe",
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
   * Read the active board — eligible (trigger label), not skipped, in an active
   * column — once per poll cycle, cached so discover() and listBoard() share a
   * single `gh project item-list`. Halving the GraphQL spend matters because this
   * token's 5000/h budget is shared with the dispatched agent.
   *
   * Status uses exclusion form: repeating a single-select `status:` qualifier is
   * AND (not OR), so "Ready OR In progress OR In review" is expressed by negating
   * the two terminal columns Backlog/Done. Assumes standard five column names.
   * Throws on read failure (issue #13) so callers distinguish empty from broken.
   */
  private readBoard(ctx: ProjectContext): GhItem[] {
    const cached = this.boardCache.get(ctx.projectId);
    if (cached && Date.now() - cached.at < GitHubIssueSourcePlugin.BOARD_CACHE_TTL_MS) {
      return cached.items;
    }
    const { owner, number } = parseProjectId(ctx.projectId);
    const { trigger, skip } = resolveLabels(ctx);
    const items = this.ghItemList(owner, number, `label:${trigger} -label:${skip} -status:Backlog -status:Done`);
    this.boardCache.set(ctx.projectId, { items, at: Date.now() });
    return items;
  }

  /**
   * Read the project item-list. Throws on read failure (issue #13) instead of
   * silently returning [] — callers (discover / listBoard / findItem) then
   * distinguish a real empty board from an unreadable one, so a transient gh
   * outage or rate limit is surfaced rather than masquerading as "no items".
   */
  private ghItemList(owner: string, number: number, query?: string): GhItem[] {
    const q = query ? ` --query "${query}"` : "";
    const raw = execSync(
      `gh project item-list ${number} --owner ${owner} --format json --limit 100${q}`,
      { encoding: "utf-8", timeout: 30_000, stdio: "pipe" },
    );
    return (JSON.parse(raw) as { items?: GhItem[] }).items ?? [];
  }

  private findItem(owner: string, number: number, sourceId: string, remote: string): GhItem | undefined {
    return this.ghItemList(owner, number).find(
      (it) => it.content && String(it.content.number) === String(sourceId) && it.content.repository === remote,
    );
  }

  private repoByName(ctx: ProjectContext, targetRepo: string): RepoRef | undefined {
    return ctx.repos.find((r) => r.name === targetRepo);
  }

  /** Post a one-time config-drift comment so we don't spam the issue every poll cycle. */
  private commentIfMissing(remote: string, issueNumber: number, ctx: ProjectContext): void {
    try {
      const raw = execSync(`gh issue view ${issueNumber} --repo ${remote} --json comments`, {
        encoding: "utf-8",
        timeout: 15_000,
        stdio: "pipe",
      });
      const comments = (JSON.parse(raw) as { comments?: Array<{ body?: string }> }).comments ?? [];
      if (comments.some((c) => c.body?.includes(DRIFT_MARKER))) return; // already notified
    } catch {
      // proceed to attempt the comment anyway
    }
    try {
      const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
      fs.writeFileSync(
        tmpFile,
        `<!-- ${DRIFT_MARKER} -->\n⚠️ This issue's repository \`${remote}\` is not declared in talos-loop's \`projects.json\`, so it will not be processed. Add the repo to the relevant project entry to enable it.`,
        "utf-8",
      );
      execSync(`gh issue comment ${issueNumber} --repo ${remote} --body-file "${tmpFile}"`, {
        timeout: 15_000,
        stdio: "pipe",
      });
      fs.unlinkSync(tmpFile);
    } catch (err: any) {
      ctx.logger.error(`Failed to post config-drift comment on ${remote}#${issueNumber}: ${err.message}`);
    }
  }
}
