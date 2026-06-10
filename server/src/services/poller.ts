import { execSync } from "child_process";
import { loadConfig, getEnabledRepos, type RepoConfig } from "../config.js";
import { upsertIssue, getIssue, type Issue } from "../db/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("poller");

export interface DiscoveredIssue {
  issue: Issue;
  repo: RepoConfig;
  labels: string[];
}

export interface PollResult {
  repo: RepoConfig;
  discovered: DiscoveredIssue[];
  processing: DiscoveredIssue[];
  error?: string;
}

interface GhIssue {
  number: number;
  title: string;
  url: string;
  labels: { name: string }[];
}

function ghIssueList(repo: string, label: string): GhIssue[] {
  try {
    const raw = execSync(
      `gh issue list --repo ${repo} --label "${label}" --state open --json number,title,url,labels --limit 50`,
      { encoding: "utf-8", timeout: 30_000 }
    );
    return JSON.parse(raw);
  } catch {
    // Label may not exist yet — return empty
    return [];
  }
}

function ghIssueView(repo: string, number: number): { labels: { name: string }[] } {
  try {
    const raw = execSync(
      `gh issue view ${number} --repo ${repo} --json labels`,
      { encoding: "utf-8", timeout: 15_000 }
    );
    return JSON.parse(raw);
  } catch {
    return { labels: [] };
  }
}

export function pollRepo(repo: RepoConfig): PollResult {
  const config = loadConfig();
  const discovered: DiscoveredIssue[] = [];
  const processing: DiscoveredIssue[] = [];

  try {
    // Fetch issues with trigger label
    const ghIssues = ghIssueList(repo.github, config.triggerLabel);

    for (const gh of ghIssues) {
      const labelNames = gh.labels.map((l) => l.name);
      const issue = upsertIssue(repo.github, gh.number, gh.url, gh.title);
      discovered.push({ issue, repo, labels: labelNames });
    }

    // Also check for issues with processing label (might have been picked up already)
    const processingIssues = ghIssueList(repo.github, config.processingLabel);
    for (const gh of processingIssues) {
      const labelNames = gh.labels.map((l) => l.name);
      const issue = upsertIssue(repo.github, gh.number, gh.url, gh.title);
      // Avoid duplicates if issue has both labels
      if (!discovered.find((d) => d.issue.number === gh.number)) {
        processing.push({ issue, repo, labels: labelNames });
      }
    }
  } catch (err: any) {
    log.error(`Error polling ${repo.github}: ${err.message}`);
    return { repo, discovered, processing, error: err.message };
  }

  log.info(`${repo.github}: ${discovered.length} queued, ${processing.length} processing`);
  return { repo, discovered, processing };
}

export function pollAll(): PollResult[] {
  const repos = getEnabledRepos();
  log.info(`Polling ${repos.length} repos...`);
  return repos.map(pollRepo);
}

/** Get current labels for a specific issue from GitHub */
export function getIssueLabels(repo: string, number: number): string[] {
  try {
    const data = ghIssueView(repo, number);
    return data.labels.map((l) => l.name);
  } catch {
    return [];
  }
}
