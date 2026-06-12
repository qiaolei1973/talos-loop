import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { IssueSourcePlugin, SourceContext, RawIssue, IssueStatus, StatusTransition } from "../../types/plugin.js";

/** GitHub plugin config shape (convention, enforced by the plugin) */
interface GitHubConfig {
  repo: string;
  targetRepo: string;
  triggerLabel: string;
  processingLabel: string;
  doneLabel: string;
  failedLabel: string;
}

function getConfig(ctx: SourceContext): GitHubConfig {
  return ctx.config as unknown as GitHubConfig;
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
    const config = getConfig(ctx);
    const labels = [
      { name: config.triggerLabel, color: "0075CA", desc: "Ready for agent to process" },
      { name: config.processingLabel, color: "FBCA04", desc: "Agent is processing this issue" },
      { name: config.doneLabel, color: "0E8A16", desc: "Agent completed, PR created" },
      { name: config.failedLabel, color: "E1141B", desc: "Agent processing failed" },
    ];
    for (const label of labels) {
      try {
        execSync(
          `gh label create "${label.name}" --repo ${config.repo} --color ${label.color} --description "${label.desc}" --force`,
          { timeout: 10_000 }
        );
      } catch {
        // label might already exist
      }
    }
    ctx.logger.info(`GitHub plugin initialized for ${config.repo}`);
  }

  async discover(ctx: SourceContext): Promise<RawIssue[]> {
    const config = getConfig(ctx);
    const results: RawIssue[] = [];

    // Fetch issues with trigger label
    const triggerIssues = this.ghIssueList(config.repo, config.triggerLabel);
    // Fetch issues with processing label
    const processingIssues = this.ghIssueList(config.repo, config.processingLabel);

    // Deduplicate by issue number
    const seen = new Set<number>();

    for (const gh of [...triggerIssues, ...processingIssues]) {
      if (seen.has(gh.number)) continue;
      seen.add(gh.number);

      results.push({
        sourceType: "github",
        sourceId: String(gh.number),
        url: gh.url,
        title: gh.title,
        targetRepo: config.targetRepo,
        metadata: {
          labels: gh.labels.map((l) => l.name),
        },
      });
    }

    ctx.logger.info(`${config.repo}: discovered ${results.length} issues`);
    return results;
  }

  async getStatus(ctx: SourceContext, sourceId: string): Promise<IssueStatus> {
    const config = getConfig(ctx);
    try {
      const raw = execSync(
        `gh issue view ${sourceId} --repo ${config.repo} --json labels`,
        { encoding: "utf-8", timeout: 15_000 }
      );
      const data = JSON.parse(raw);
      return { labels: data.labels.map((l: { name: string }) => l.name) };
    } catch {
      return { labels: [] };
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

  async onStatusChange(ctx: SourceContext, sourceId: string, transition: StatusTransition): Promise<void> {
    const config = getConfig(ctx);
    try {
      execSync(
        `gh issue edit ${sourceId} --repo ${config.repo} --remove-label "${transition.from}" --add-label "${transition.to}"`,
        { timeout: 15_000 }
      );
    } catch (err: any) {
      ctx.logger.error(`Failed to edit labels on ${config.repo}#${sourceId}: ${err.message}`);
    }
  }

  async onComment(ctx: SourceContext, sourceId: string, comment: string): Promise<void> {
    const config = getConfig(ctx);
    try {
      const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, comment, "utf-8");
      execSync(`gh issue comment ${sourceId} --repo ${config.repo} --body-file "${tmpFile}"`, {
        timeout: 15_000,
      });
      fs.unlinkSync(tmpFile);
    } catch (err: any) {
      ctx.logger.error(`Failed to comment on ${config.repo}#${sourceId}: ${err.message}`);
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
}
