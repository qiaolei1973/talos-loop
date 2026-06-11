import { execSync } from "child_process";
import fs from "fs";
import os from "os";
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
import { pollRepo, getIssueLabels, type PollResult, type DiscoveredIssue } from "./poller.js";
import * as tmux from "./tmux.js";
import { createLogger } from "./logger.js";

const log = createLogger("dispatcher");

export interface DispatchResult {
  dispatched: number;
  completed: number;
  failed: number;
  idle: boolean;
}

function buildPrompt(
  repo: string,
  issueNumber: number,
  repoPath: string,
): string {
  return [
    `你是一个自动化编码代理。请实现 GitHub Issue #${issueNumber}。`,
    ``,
    `要求：`,
    `- 阅读并理解 issue 内容`,
    `- 使用 git worktree 隔离工作（自行决定 worktree 路径和分支名，请使用语义化的分支名）`,
    `- 在 worktree 中完成所有开发工作`,
    `- 完成后提交代码，推送分支，并创建 Pull Request 关联 Issue #${issueNumber}`,
    `- 最后清理 worktree：cd ${repoPath} && git worktree remove <你的worktree路径>`,
    ``,
    `完成后在输出中单独一行输出 PR 的 URL。`,
  ].join("\n");
}

/** Use gh CLI to find a PR that references the issue number */
function findPrUrl(repo: string, issueNumber: number): string | null {
  try {
    const result = execSync(
      `gh pr list --repo ${repo} --state open --json url --jq '.[0].url'`,
      { timeout: 15_000, encoding: "utf-8" },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function ghEditLabel(repo: string, number: number, removeLabel: string, addLabel: string): void {
  try {
    execSync(
      `gh issue edit ${number} --repo ${repo} --remove-label "${removeLabel}" --add-label "${addLabel}"`,
      { timeout: 15_000 }
    );
  } catch (err: any) {
    log.error(`Failed to edit labels on ${repo}#${number}: ${err.message}`);
  }
}

function ghComment(repo: string, number: number, body: string): void {
  try {
    const tmpFile = path.join(os.tmpdir(), `tl-comment-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, body, "utf-8");
    execSync(`gh issue comment ${number} --repo ${repo} --body-file "${tmpFile}"`, {
      timeout: 15_000,
    });
    fs.unlinkSync(tmpFile);
  } catch (err: any) {
    log.error(`Failed to comment on ${repo}#${number}: ${err.message}`);
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
    // Capture pane output while session is still alive (before isAlive check)
    const lastOutput = tmux.captureOutput(session.tmux_session);

    if (tmux.isAlive(session.tmux_session)) {
      continue;
    }

    // Session has exited — determine result
    // Try finding PR URL from captured terminal output first, then via gh CLI
    const prMatch = lastOutput.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
    const prUrl = prMatch ? prMatch[0] : findPrUrl(repo, number);

    if (prUrl) {
      log.info(`✅ ${repo}#${number} done — ${prUrl}`);
      updateSessionStatus(session.id, "done", prUrl);
      ghEditLabel(repo, number, config.processingLabel, config.doneLabel);
      ghComment(repo, number, `✅ Agent completed. PR: ${prUrl}`);
      updateIssueTmux(repo, number, null);
      completed++;
    } else {
      // Extract last meaningful lines from captured output as error summary
      const tail = lastOutput.trim().slice(-500) || "Session exited without creating a PR";
      log.info(`❌ ${repo}#${number} failed`);
      updateSessionStatus(session.id, "failed", undefined, tail);
      ghEditLabel(repo, number, config.processingLabel, config.failedLabel);
      ghComment(repo, number, `❌ Agent processing failed.\n\n\`\`\`\n${tail.slice(0, 1000)}\n\`\`\``);
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
    log.info(`Max parallel (${config.maxParallel}) reached, ${runningCount} running`);
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

    // Real-time label verification — guard against stale poll data
    const currentLabels = getIssueLabels(repo.github, issue.number);
    if (!currentLabels.includes(config.triggerLabel)) {
      log.info(`Skipping ${repo.github}#${issue.number} — trigger label no longer present`);
      continue;
    }
    if (currentLabels.includes(config.processingLabel) || currentLabels.includes(config.doneLabel)) {
      log.warn(`Skipping ${repo.github}#${issue.number} — unexpected labels: ${currentLabels.join(", ")}`);
      continue;
    }

    const session = tmux.sessionName(repo.name, issue.number);
    const prompt = buildPrompt(repo.github, issue.number, repo.path);

    // Write prompt to temp file to avoid shell escaping issues
    const promptFile = path.join(os.tmpdir(), `tl-prompt-${session}.txt`);
    fs.writeFileSync(promptFile, prompt, "utf-8");

    const command = `cd ${repo.path} && claude "$(cat ${promptFile})" --dangerously-skip-permissions`;

    log.info(`🚀 Dispatching ${repo.github}#${issue.number} → session ${session}`);

    try {
      // Update GitHub labels
      ghEditLabel(repo.github, issue.number, config.triggerLabel, config.processingLabel);
      ghComment(repo.github, issue.number, "🤖 Agent has started processing this issue...");

      // Create tmux session
      tmux.createSession(session, command);

      // Record in DB
      updateIssueTmux(repo.github, issue.number, session);
      createSession(issue.id, session);

      dispatched++;
    } catch (err: any) {
      log.error(`Failed to dispatch ${repo.github}#${issue.number}: ${err.message}`);
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
