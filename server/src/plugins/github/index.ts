import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  IssueSourcePlugin,
  SourceContext,
  RawIssue,
  IssueStatus,
  IssueState,
  StatusTransition,
} from "../../types/plugin.js";

/**
 * Default label vocabulary. Used as-is unless overridden per-source via the flat
 * optional fields below. Core never reads these — they live entirely in the plugin.
 */
const DEFAULT_TRIGGER = "ready-for-agent";
const DEFAULT_PROCESSING = "agent-processing";
const DEFAULT_DONE = "agent-done";
const DEFAULT_FAILED = "agent-failed";

/** GitHub plugin config shape — everything optional (defaults apply); `repo` overrides the bound repo's remote. */
interface GitHubConfig {
  repo?: string;                // "owner/repo" override; defaults to ctx.repo.remote
  triggerLabel?: string;
  processingLabel?: string;
  doneLabel?: string;
  failedLabel?: string;
}

interface GitHubRuntime {
  repo: string;                 // resolved "owner/repo"
  triggerLabel: string;
  processingLabel: string;
  doneLabel: string;
  failedLabel: string;
  repoName: string;             // ctx.repo.name (RawIssue.targetRepo)
}

/** Resolve runtime config: merge flat overrides with defaults, derive "owner/repo" and targetRepo from ctx. */
function resolveRuntime(ctx: SourceContext): GitHubRuntime {
  const c = (ctx.config ?? {}) as GitHubConfig;
  const repo = c.repo ?? ctx.repo?.remote;
  if (!repo) {
    throw new Error(
      "GitHub source cannot resolve 'owner/repo': set `repo` in source.config or bind a repo whose `git remote` can be inferred.",
    );
  }
  if (!ctx.repo) {
    throw new Error("GitHub source is not bound to a repo — check the source's `repo` field and repos.json.");
  }
  return {
    repo,
    repoName: ctx.repo.name,
    triggerLabel: c.triggerLabel ?? DEFAULT_TRIGGER,
    processingLabel: c.processingLabel ?? DEFAULT_PROCESSING,
    doneLabel: c.doneLabel ?? DEFAULT_DONE,
    failedLabel: c.failedLabel ?? DEFAULT_FAILED,
  };
}

interface GhIssue {
  number: number;
  title: string;
  url: string;
  labels: { name: string }[];
}

export class GitHubIssueSourcePlugin implements IssueSourcePlugin {
  name = "github";

  async init(ctx: SourceContext): Promise<void> {
    const rt = resolveRuntime(ctx);
    const labels = [
      { name: rt.triggerLabel, color: "0075CA", desc: "Ready for agent to process" },
      { name: rt.processingLabel, color: "FBCA04", desc: "Agent is processing this issue" },
      { name: rt.doneLabel, color: "0E8A16", desc: "Agent completed, PR created" },
      { name: rt.failedLabel, color: "E1141B", desc: "Agent processing failed" },
    ];
    for (const label of labels) {
      try {
        execSync(
          `gh label create "${label.name}" --repo ${rt.repo} --color ${label.color} --description "${label.desc}" --force`,
          { timeout: 10_000 }
        );
      } catch {
        // label might already exist
      }
    }
    ctx.logger.info(`GitHub plugin initialized for ${rt.repo}`);
  }

  async discover(ctx: SourceContext): Promise<RawIssue[]> {
    const rt = resolveRuntime(ctx);
    const results: RawIssue[] = [];
    const seen = new Set<number>();

    // Processing issues first so a mid-transition issue (carrying both the
    // trigger and processing markers) is classified as processing, which wins
    // over queued per the priority rule.
    for (const gh of this.ghIssueList(rt.repo, rt.processingLabel)) {
      if (seen.has(gh.number)) continue;
      seen.add(gh.number);
      results.push(this.toRaw(gh, rt, "processing"));
    }
    for (const gh of this.ghIssueList(rt.repo, rt.triggerLabel)) {
      if (seen.has(gh.number)) continue;
      seen.add(gh.number);
      results.push(this.toRaw(gh, rt, "queued"));
    }

    ctx.logger.info(`${rt.repo}: discovered ${results.length} issues`);
    return results;
  }

  async getStatus(ctx: SourceContext, sourceId: string): Promise<IssueStatus> {
    const rt = resolveRuntime(ctx);
    try {
      const raw = execSync(
        `gh issue view ${sourceId} --repo ${rt.repo} --json labels`,
        { encoding: "utf-8", timeout: 15_000 }
      );
      const data = JSON.parse(raw);
      const labels: string[] = data.labels.map((l: { name: string }) => l.name);
      return { state: this.labelsToState(labels, rt) };
    } catch {
      return { state: null };
    }
  }

  async test(ctx: SourceContext): Promise<boolean> {
    try {
      execSync("gh auth status", { timeout: 10_000, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async transition(ctx: SourceContext, sourceId: string, transition: StatusTransition): Promise<void> {
    const rt = resolveRuntime(ctx);
    const fromLabel = this.stateToLabel(transition.from, rt);
    const toLabel = this.stateToLabel(transition.to, rt);
    try {
      execSync(
        `gh issue edit ${sourceId} --repo ${rt.repo} --remove-label "${fromLabel}" --add-label "${toLabel}"`,
        { timeout: 15_000 }
      );
    } catch (err: any) {
      ctx.logger.error(
        `Failed to transition ${rt.repo}#${sourceId} (${transition.from}→${transition.to}): ${err.message}`
      );
    }
  }

  async onComment(ctx: SourceContext, sourceId: string, comment: string): Promise<void> {
    const rt = resolveRuntime(ctx);
    try {
      const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, comment, "utf-8");
      execSync(`gh issue comment ${sourceId} --repo ${rt.repo} --body-file "${tmpFile}"`, {
        timeout: 15_000,
      });
      fs.unlinkSync(tmpFile);
    } catch (err: any) {
      ctx.logger.error(`Failed to comment on ${rt.repo}#${sourceId}: ${err.message}`);
    }
  }

  private ghIssueList(repo: string, label: string): GhIssue[] {
    try {
      const raw = execSync(
        `gh issue list --repo ${repo} --label "${label}" --state open --json number,title,url,labels --limit 50`,
        { encoding: "utf-8", timeout: 30_000 }
      );
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private toRaw(gh: GhIssue, rt: GitHubRuntime, state: IssueState): RawIssue {
    return {
      sourceId: String(gh.number),
      url: gh.url,
      title: gh.title,
      targetRepo: rt.repoName,
      state,
    };
  }

  /** Resolve a set of GitHub labels to a single standard state.
   *  Priority: terminal states over in-flight; failure over success. */
  private labelsToState(labels: string[], rt: GitHubRuntime): IssueState | null {
    if (labels.includes(rt.failedLabel)) return "failed";
    if (labels.includes(rt.doneLabel)) return "done";
    if (labels.includes(rt.processingLabel)) return "processing";
    if (labels.includes(rt.triggerLabel)) return "queued";
    return null;
  }

  private stateToLabel(state: IssueState, rt: GitHubRuntime): string {
    switch (state) {
      case "queued": return rt.triggerLabel;
      case "processing": return rt.processingLabel;
      case "done": return rt.doneLabel;
      case "failed": return rt.failedLabel;
    }
  }
}
