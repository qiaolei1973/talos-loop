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

function buildPrompt(repo: string, issueNumber: number, title: string): string {
  return [
    `你是一个自动化编码代理。请实现 GitHub Issue #${issueNumber}。`,
    ``,
    `步骤：`,
    `1. 使用 gh issue view ${issueNumber} --repo ${repo} 阅读 issue 的完整内容`,
    `2. 阅读并理解 issue 的需求`,
    `3. 探索代码库，理解相关代码`,
    `4. 实现所需的改动`,
    `5. 创建名为 "agent/issue-${issueNumber}" 的分支，提交改动`,
    `6. 推送分支并创建 Pull Request：gh pr create --title "fix: ${title}" --body "Closes #${issueNumber}"`,
    ``,
    `注意：完成后在输出中单独一行输出 PR 的 URL。`,
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
    const tmpFile = path.join(require("os").tmpdir(), `tl-comment-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, body, "utf-8");
    execSync(`gh issue comment ${number} --repo ${repo} --body-file "${tmpFile}"`, {
      timeout: 15_000,
    });
    fs.unlinkSync(tmpFile);
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
    const prompt = buildPrompt(repo.github, issue.number, issue.title || `Issue #${issue.number}`);
    const promptFile = path.join(config.logDir, `${repo.name}-${issue.number}-prompt.txt`);
    fs.writeFileSync(promptFile, prompt, "utf-8");
    // Use shell script to avoid quoting issues; stdbuf for line-buffered output
    const scriptFile = path.join(config.logDir, `${repo.name}-${issue.number}-run.sh`);
    fs.writeFileSync(scriptFile, `#!/bin/bash
cd ${repo.path}
claude -p "$(cat ${promptFile})" --verbose --dangerously-skip-permissions 2>&1 | tee ${logPath}
`, "utf-8");
    fs.chmodSync(scriptFile, 0o755);
    const command = scriptFile;

    console.log(`[dispatcher] 🚀 Dispatching ${repo.github}#${issue.number} → session ${session}`);
    console.log(`[dispatcher] DEBUG command: ${command}`);

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
