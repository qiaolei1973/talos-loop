import { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { loadConfig, getEnabledRepos } from "../config.js";
import { getAllIssues, getIssuesByRepo, getSessionsByIssue, getDb } from "../db/index.js";
import { pollAll, getIssueLabels } from "../services/poller.js";
import { dispatch } from "../services/dispatcher.js";
import { getRunningSessions } from "../db/index.js";
import * as tmux from "../services/tmux.js";
import { createLogger } from "../services/logger.js";

const log = createLogger("api");

let lastPollAt: Date | null = null;
let nextPollAt: Date | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function startPoller(): void {
  const config = loadConfig();

  // Run first poll immediately
  runPollCycle();

  // Schedule recurring polls
  function scheduleNext(): void {
    nextPollAt = new Date(Date.now() + config.pollInterval);
    pollTimer = setTimeout(() => {
      runPollCycle();
      scheduleNext();
    }, config.pollInterval);
  }
  scheduleNext();
}

export function stopPoller(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export function runPollCycle(): { pollResults: ReturnType<typeof pollAll>; dispatchResult: ReturnType<typeof dispatch> } {
  const pollResults = pollAll();
  const dispatchResult = dispatch(pollResults);
  lastPollAt = new Date();
  return { pollResults, dispatchResult };
}

function getIssueById(id: number) {
  return getDb().prepare("SELECT * FROM issues WHERE id = ?").get(id) as any;
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // Global status
  app.get("/api/status", async () => {
    const config = loadConfig();
    const running = getRunningSessions();
    return {
      status: "ok",
      runningCount: running.length,
      maxParallel: config.maxParallel,
      lastPollAt,
      nextPollAt,
      pollInterval: config.pollInterval,
    };
  });

  // List repos
  app.get("/api/repos", async () => {
    const repos = getEnabledRepos();
    return repos.map((r) => ({
      name: r.name,
      github: r.github,
      enabled: r.enabled,
    }));
  });

  // Issues for a specific repo
  app.get("/api/repos/:name/issues", async (request) => {
    const { name } = request.params as { name: string };
    const config = loadConfig();
    const repo = config.repos.find((r) => r.name === name);
    if (!repo) return { error: "Repo not found" };

    const issues = getIssuesByRepo(repo.github);
    return issues.map((issue) => {
      const labels = getIssueLabels(repo.github, issue.number);
      return { ...issue, githubLabels: labels };
    });
  });

  // All issues
  app.get("/api/issues", async () => {
    const issues = getAllIssues();
    const config = loadConfig();
    return issues.map((issue) => {
      const sessions = getSessionsByIssue(issue.id);
      const labels = getIssueLabels(issue.repo, issue.number);
      let status = "unknown";
      if (labels.includes(config.doneLabel)) status = "done";
      else if (labels.includes(config.processingLabel)) status = "processing";
      else if (labels.includes(config.failedLabel)) status = "failed";
      else if (labels.includes(config.triggerLabel)) status = "queued";
      else status = "other";

      return { ...issue, status, githubLabels: labels, sessions };
    });
  });

  // Sessions for an issue
  app.get("/api/issues/:id/sessions", async (request) => {
    const { id } = request.params as { id: string };
    return getSessionsByIssue(parseInt(id, 10));
  });

  // Retry a failed issue
  app.post("/api/issues/:id/retry", async (request) => {
    const { id } = request.params as { id: string };
    const issue = getIssueById(parseInt(id, 10));
    if (!issue) return { error: "Issue not found" };

    const config = loadConfig();
    try {
      execSync(
        `gh issue edit ${issue.number} --repo ${issue.repo} --remove-label "${config.failedLabel}" --add-label "${config.triggerLabel}"`,
        { timeout: 15_000 }
      );
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // Manual poll trigger
  app.post("/api/poll", async () => {
    const result = runPollCycle();
    return result;
  });

  // Webhook endpoint (optional — just triggers a poll)
  app.post("/api/webhook", async (_request, _reply) => {
    log.info("Received webhook event, triggering poll...");
    const result = runPollCycle();
    return { triggered: true, ...result };
  });
}
