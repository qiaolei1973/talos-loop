import { FastifyInstance } from "fastify";
import { loadConfig, getEnabledSources } from "../config.js";
import { getAllIssues, getIssuesByTargetRepo, getSessionsByIssue, getIssueById } from "../db/index.js";
import { pollAll } from "../services/poller.js";
import { dispatch } from "../services/dispatcher.js";
import { getRunningSessions } from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import { createLogger } from "../services/logger.js";

const log = createLogger("api");

let lastPollAt: Date | null = null;
let nextPollAt: Date | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function startPoller(): void {
  const config = loadConfig();

  // Run first poll immediately
  runPollCycle().catch((err) => {
    log.error(`Poll cycle error: ${err}`);
  });

  // Schedule recurring polls
  function scheduleNext(): void {
    nextPollAt = new Date(Date.now() + config.pollInterval);
    pollTimer = setTimeout(() => {
      runPollCycle().catch((err) => {
        log.error(`Poll cycle error: ${err}`);
      });
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

export async function runPollCycle(): Promise<{ pollResults: Awaited<ReturnType<typeof pollAll>>; dispatchResult: Awaited<ReturnType<typeof dispatch>> }> {
  const pollResults = await pollAll();
  const dispatchResult = await dispatch(pollResults);
  lastPollAt = new Date();
  return { pollResults, dispatchResult };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // Global status
  app.get("/api/status", async () => {
    const config = loadConfig();
    const running = getRunningSessions();
    const sources = getEnabledSources();
    return {
      status: "ok",
      runningCount: running.length,
      maxParallel: config.maxParallel,
      lastPollAt,
      nextPollAt,
      pollInterval: config.pollInterval,
      sources: sources.map((s) => ({ type: s.type, enabled: s.enabled })),
    };
  });

  // List repos
  app.get("/api/repos", async () => {
    const config = loadConfig();
    return config.repos.map((r) => ({
      name: r.name,
      remote: r.remote,
      path: r.path,
    }));
  });

  // Issues for a specific repo
  app.get("/api/repos/:name/issues", async (request) => {
    const { name } = request.params as { name: string };
    const issues = getIssuesByTargetRepo(name);
    return issues;
  });

  // All issues
  app.get("/api/issues", async () => {
    const issues = getAllIssues();
    return issues.map((issue) => {
      const sessions = getSessionsByIssue(issue.id);
      return { ...issue, sessions };
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

    try {
      const plugin = await resolvePlugin(issue.source_type);
      const source = loadConfig().sources.find((s) => s.type === issue.source_type);
      const ctx = { config: source?.config ?? {}, logger: log };

      const failedLabel = ctx.config.failedLabel as string;
      const triggerLabel = ctx.config.triggerLabel as string;

      if (plugin.onStatusChange) {
        await plugin.onStatusChange(ctx, issue.source_id, { from: failedLabel, to: triggerLabel });
      }
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // Manual poll trigger
  app.post("/api/poll", async () => {
    const result = await runPollCycle();
    return result;
  });

  // Webhook endpoint (optional — just triggers a poll)
  app.post("/api/webhook", async (_request, _reply) => {
    log.info("Received webhook event, triggering poll...");
    const result = await runPollCycle();
    return { triggered: true, ...result };
  });
}
