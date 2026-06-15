import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
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
    const { owner, number } = parseProjectId(ctx.projectId);
    try {
      this.ensureCache(ctx);
    } catch (err: any) {
      ctx.logger.error(`discover: failed to resolve project meta: ${err.message}`);
      return [];
    }
    const { trigger, skip } = resolveLabels(ctx);

    // Server-side filter: only items carrying the trigger label and NOT the skip
    // label (item-list content carries no labels, so we lean on --query).
    const items = this.ghItemList(owner, number, `label:${trigger} -label:${skip}`);
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
    } catch {
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

    const item = this.findItem(owner, number, sourceId, repo.remote);
    if (!item) {
      ctx.logger.error(`transition: project item for ${repo.remote}#${sourceId} not found`);
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

  private ghItemList(owner: string, number: number, query?: string): GhItem[] {
    try {
      const q = query ? ` --query "${query}"` : "";
      const raw = execSync(
        `gh project item-list ${number} --owner ${owner} --format json --limit 100${q}`,
        { encoding: "utf-8", timeout: 30_000, stdio: "pipe" },
      );
      return (JSON.parse(raw) as { items?: GhItem[] }).items ?? [];
    } catch {
      return [];
    }
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
