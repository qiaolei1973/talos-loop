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

function parseLogForPrUrl(logPath: string): string | null {
  try {
    const logFile = fs.readFileSync(logPath, "utf-8");
    const match = logFile.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function parseLogForError(logPath: string): string {
  try {
    const logFile = fs.readFileSync(logPath, "utf-8");
    // Take last 500 chars as error summary
    const tail = logFile.slice(-500).trim();
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
    log.error(`Failed to edit labels on ${repo}#${number}: ${err.message}`);
  }
}

function ghComment(repo: string, number: number, body: string): void {
  try {
    const tmpFile = path.join(require("os").tmpdir(), `tl-comment-${Date.now()}.md`);
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
    const alive = tmux.isAlive(session.tmux_session);

    if (alive) {
      continue;
    }

    // Session has exited — determine result
    const prUrl = session.log_path ? parseLogForPrUrl(session.log_path) : null;

    if (prUrl) {
      log.info(`✅ ${repo}#${number} done — ${prUrl}`);
      updateSessionStatus(session.id, "done", prUrl);
      ghEditLabel(repo, number, config.processingLabel, config.doneLabel);
      ghComment(repo, number, `✅ Agent completed. PR: ${prUrl}`);
      updateIssueTmux(repo, number, null);
      completed++;
    } else {
      const errorSummary = session.log_path ? parseLogForError(session.log_path) : "No log available";
      log.info(`❌ ${repo}#${number} failed`);
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
    const logPath = path.join(config.logDir, `${repo.name}-${issue.number}.log`);

    // Build claude command
    const prompt = buildPrompt(repo.github, issue.number, repo.path);
    const promptFile = path.join(config.logDir, `${repo.name}-${issue.number}-prompt.txt`);
    fs.writeFileSync(promptFile, prompt, "utf-8");

    const scriptFile = path.join(config.logDir, `${repo.name}-${issue.number}-run.sh`);
    fs.writeFileSync(scriptFile, `#!/bin/bash
cd ${repo.path}
claude "$(cat ${promptFile})" --dangerously-skip-permissions
`, "utf-8");
    fs.chmodSync(scriptFile, 0o755);
    const command = scriptFile;

    log.info(`🚀 Dispatching ${repo.github}#${issue.number} → session ${session}`);

    try {
      // Update GitHub labels
      ghEditLabel(repo.github, issue.number, config.triggerLabel, config.processingLabel);
      ghComment(repo.github, issue.number, "🤖 Agent has started processing this issue...");

      // Create tmux session (with pipe-pane logging)
      tmux.createSession(session, command, logPath);

      // Record in DB
      updateIssueTmux(repo.github, issue.number, session);
      createSession(issue.id, session, logPath);

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
