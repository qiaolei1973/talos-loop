import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { loadConfig } from "../config.js";
import {
  getDb,
  getRunningSessions,
  createSession,
  updateSessionStatus,
  updateIssueTmux,
  type Session,
} from "../db/index.js";
import { pollRepo, type PollResult, type DiscoveredIssue } from "./poller.js";
import * as tmux from "./tmux.js";

export interface DispatchResult {
  dispatched: number;
  completed: number;
  failed: number;
  idle: boolean;
}

function buildPrompt(title: string, body: string): string {
  return [
    `You are an autonomous coding agent. Your task is to resolve the following GitHub issue.`,
    ``,
    `## Issue: ${title}`,
    ``,
    body,
    ``,
    `## Instructions`,
    `1. Read and understand the issue thoroughly`,
    `2. Explore the codebase to understand the relevant code`,
    `3. Implement the necessary changes`,
    `4. Create a git branch named "agent/issue-{number}" and commit your changes`,
    `5. Push the branch and create a Pull Request using: gh pr create --title "{title}" --body "Closes #{number}"`,
    `6. Make sure the PR description references the issue number so it auto-closes on merge`,
    ``,
    `Important: When done, output the PR URL on a line by itself so it can be detected.`,
  ].join("\n");
}

function parseLogForPrUrl(logPath: string): string | null {
  try {
    const log = fs.readFileSync(logPath, "utf-8");
    const match = log.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function parseLogForError(logPath: string): string {
  try {
    const log = fs.readFileSync(logPath, "utf-8");
    // Take last 500 chars as error summary
    const tail = log.slice(-500).trim();
    return tail || "Unknown error (empty log)";
  } catch {
    return "Failed to read log file";
  }
}

function ghEditLabel(repo: string, number: number, removeLabel: string, addLabel: string): void {
  try {
    execSync(
      `gh issue edit ${number} --repo ${repo} --remove-label "${removeLabel}" --add-label "${addLabel}"`,
      { timeout: 15_000 }
    );
  } catch (err: any) {
    console.error(`[dispatcher] Failed to edit labels on ${repo}#${number}: ${err.message}`);
  }
}

function ghComment(repo: string, number: number, body: string): void {
  try {
    execSync(`gh issue comment ${number} --repo ${repo} --body "${body.replace(/"/g, '\\"')}"`, {
      timeout: 15_000,
    });
  } catch (err: any) {
    console.error(`[dispatcher] Failed to comment on ${repo}#${number}: ${err.message}`);
  }
}

/** Ensure GitHub labels exist (create if needed) */
export async function ensureLabels(repo: string): Promise<void> {
  const config = loadConfig();
  const labels = [
    { name: config.processingLabel, color: "FBCA04", desc: "Agent is processing this issue" },
    { name: config.doneLabel, color: "0E8A16", desc: "Agent completed, PR created" },
    { name: config.failedLabel, color: "E1141B", desc: "Agent processing failed" },
  ];
  for (const label of labels) {
    try {
      execSync(
        `gh label create "${label.name}" --repo ${repo} --color ${label.color} --description "${label.desc}" --force`,
        { timeout: 10_000 }
      );
    } catch {
      // label might already exist
    }
  }
}

/** Get running sessions joined with their issue info */
function getRunningSessionsWithIssues(): (Session & { repo: string; number: number })[] {
  return getDb().prepare(`
    SELECT s.*, i.repo, i.number
    FROM sessions s
    JOIN issues i ON s.issue_id = i.id
    WHERE s.status = 'running'
  `).all() as (Session & { repo: string; number: number })[];
}

/** Check running sessions, detect completions */
function checkRunningSessions(): { completed: number; failed: number } {
  const config = loadConfig();
  const running = getRunningSessionsWithIssues();
  let completed = 0;
  let failed = 0;

  for (const { repo, number, ...session } of running) {
    const alive = tmux.isAlive(session.tmux_session);

    if (alive) {
      // Still running, skip
      continue;
    }

    // Session has exited — determine result

    const prUrl = session.log_path ? parseLogForPrUrl(session.log_path) : null;

    if (prUrl) {
      // Success!
      console.log(`[dispatcher] ✅ ${repo}#${number} done — ${prUrl}`);
      updateSessionStatus(session.id, "done", prUrl);
      ghEditLabel(repo, number, config.processingLabel, config.doneLabel);
      ghComment(repo, number, `✅ Agent completed. PR: ${prUrl}`);
      updateIssueTmux(repo, number, null);
      completed++;
    } else {
      // Failed
      const errorSummary = session.log_path ? parseLogForError(session.log_path) : "No log available";
      console.log(`[dispatcher] ❌ ${repo}#${number} failed`);
      updateSessionStatus(session.id, "failed", undefined, errorSummary.slice(0, 500));
      ghEditLabel(repo, number, config.processingLabel, config.failedLabel);
      ghComment(repo, number, `❌ Agent processing failed.\n\n\`\`\`\n${errorSummary.slice(0, 1000)}\n\`\`\``);
      updateIssueTmux(repo, number, null);
      failed++;
    }
  }

  return { completed, failed };
}

/** Dispatch new issues from poll results */
function dispatchNew(pollResults: PollResult[]): number {
  const config = loadConfig();
  const runningCount = getRunningSessions().length;

  if (runningCount >= config.maxParallel) {
    return 0;
  }

  // Collect all discovered (queued) issues across repos
  const candidates: DiscoveredIssue[] = pollResults
    .flatMap((r) => r.discovered)
    .filter((d) => d.labels.includes(config.triggerLabel));

  // Sort by issue number (lower = older = higher priority)
  candidates.sort((a, b) => a.issue.number - b.issue.number);

  let dispatched = 0;
  const slotsAvailable = config.maxParallel - runningCount;

  for (const candidate of candidates.slice(0, slotsAvailable)) {
    const { issue, repo } = candidate;
    const session = tmux.sessionName(repo.name, issue.number);
    const logPath = path.join(config.logDir, `${repo.name}-${issue.number}.log`);

    // Build claude command
    const prompt = buildPrompt(issue.title || `Issue #${issue.number}`, issue.url);
    const safePrompt = prompt.replace(/'/g, "'\\''");
    const command = `cd ${repo.path} && claude -p '${safePrompt}' 2>&1 | tee ${logPath}`;

    console.log(`[dispatcher] 🚀 Dispatching ${repo.github}#${issue.number} → session ${session}`);

    try {
      // Update GitHub labels
      ghEditLabel(repo.github, issue.number, config.triggerLabel, config.processingLabel);
      ghComment(repo.github, issue.number, "🤖 Agent has started processing this issue...");

      // Create tmux session
      tmux.createSession(session, command);

      // Record in DB
      updateIssueTmux(repo.github, issue.number, session);
      createSession(issue.id, session, logPath);

      dispatched++;
    } catch (err: any) {
      console.error(`[dispatcher] Failed to dispatch ${repo.github}#${issue.number}: ${err.message}`);
      ghEditLabel(repo.github, issue.number, config.processingLabel, config.failedLabel);
    }
  }

  return dispatched;
}

/** Main dispatch cycle: check running + dispatch new */
export function dispatch(pollResults: PollResult[]): DispatchResult {
  const { completed, failed } = checkRunningSessions();
  const dispatched = dispatchNew(pollResults);
  const runningCount = getRunningSessions().length;

  return {
    dispatched,
    completed,
    failed,
    idle: runningCount === 0 && dispatched === 0,
  };
}
