import { FastifyInstance } from "fastify";
import { loadConfig, getEnabledProjects, loadProjects, getProjectById, buildProjectContext } from "../config.js";
import {
  getAllIssues,
  getIssuesByTargetRepo,
  getSessionsByIssue,
  getIssueById,
  getIssue,
  getRunningSessions,
  markSessionSkipped,
  setSessionPrUrl,
  updateIssueStatus,
  updateIssueTmux,
  type Issue,
} from "../db/index.js";
import { pollAll } from "../services/poller.js";
import { dispatch } from "../services/dispatcher.js";
import { resolvePlugin, getPluginName } from "../plugins/loader.js";
import { createLogger } from "../services/logger.js";

const log = createLogger("api");

let lastPollAt: Date | null = null;
let nextPollAt: Date | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Attach the plugin display name (project_name) to each issue, keyed by project_type. */
async function withProjectName(issues: Issue[]): Promise<(Issue & { project_name: string })[]> {
  const nameCache = new Map<string, string>();
  for (const issue of issues) {
    if (!nameCache.has(issue.project_type)) {
      nameCache.set(issue.project_type, await getPluginName(issue.project_type));
    }
  }
  return issues.map((issue) => ({ ...issue, project_name: nameCache.get(issue.project_type)! }));
}

export function startPoller(): void {
  const config = loadConfig();

  runPollCycle().catch((err) => {
    log.error(`Poll cycle error: ${err}`);
  });

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
    const projects = getEnabledProjects();
    return {
      status: "ok",
      runningCount: running.length,
      maxParallel: config.maxParallel,
      lastPollAt,
      nextPollAt,
      pollInterval: config.pollInterval,
      projects: await Promise.all(
        projects.map(async (p) => ({ projectId: p.projectId, name: await getPluginName(p.projectType), enabled: p.enabled })),
      ),
    };
  });

  // List projects and their repos
  app.get("/api/projects", async () => {
    return Promise.all(
      loadProjects().map(async (p) => ({
        projectId: p.projectId,
        projectType: p.projectType,
        enabled: p.enabled,
        name: await getPluginName(p.projectType),
        repos: p.repos.map((r) => ({ name: r.name, path: r.path, remote: r.remote })),
      })),
    );
  });

  // Union of repos across all projects (dashboard grouping helper)
  app.get("/api/repos", async () => {
    const seen = new Map<string, { name: string; path: string; remote?: string }>();
    for (const p of loadProjects()) {
      for (const r of p.repos) {
        if (!seen.has(r.name)) seen.set(r.name, { name: r.name, path: r.path, remote: r.remote });
      }
    }
    return [...seen.values()];
  });

  // Issues for a specific repo
  app.get("/api/repos/:name/issues", async (request) => {
    const { name } = request.params as { name: string };
    return withProjectName(getIssuesByTargetRepo(name));
  });

  // All issues
  app.get("/api/issues", async () => {
    const issues = await withProjectName(getAllIssues());
    return issues.map((issue) => ({
      ...issue,
      sessions: getSessionsByIssue(issue.id),
    }));
  });

  // Sessions for an issue
  app.get("/api/issues/:id/sessions", async (request) => {
    const { id } = request.params as { id: string };
    return getSessionsByIssue(parseInt(id, 10));
  });

  // Unified agent-signal route. `:action` dispatches to the matching plugin
  // method. New capabilities need no new route — a plugin just declares them via
  // capabilities() and (for non-standard actions) the dispatcher grows a case.
  app.post("/api/projects/:projectId/issues/:sourceId/actions/:action", async (request, reply) => {
    const { projectId, sourceId, action } = request.params as { projectId: string; sourceId: string; action: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const targetRepo = body.targetRepo as string | undefined;

    const project = getProjectById(projectId);
    if (!project) return { error: `Unknown projectId "${projectId}"` };

    try {
      const plugin = await resolvePlugin(project.projectType);
      const ctx = buildProjectContext(project, log);

      switch (action) {
        case "submit-pr": {
          const branch = body.branch as string | undefined;
          if (!targetRepo || !branch) return { error: "targetRepo and branch required" };
          if (!plugin.submitPr) return { error: "Plugin does not support submit-pr" };
          // Single responsibility: the plugin creates the PR and returns its URL;
          // we only persist it so checkRunningSessions finds it on the session.
          const prUrl = await plugin.submitPr(ctx, sourceId, branch, targetRepo);
          const issue = getIssue(projectId, sourceId);
          if (issue) setSessionPrUrl(issue.id, prUrl);
          return { success: true, prUrl };
        }
        case "comment": {
          const message = body.message as string | undefined;
          if (!targetRepo || !message) return { error: "targetRepo and message required" };
          if (!plugin.onComment) return { error: "Plugin does not support comments" };
          await plugin.onComment(ctx, sourceId, message, targetRepo);
          return { success: true };
        }
        case "skip": {
          if (!targetRepo) return { error: "targetRepo required" };
          const reason = (body.reason as string | undefined) ?? "No reason provided";
          await plugin.skip(ctx, sourceId, targetRepo, reason);
          // Coordination DB ops (intentional, route-layer glue): mark the running
          // session skipped, return the issue to queued (Ready), and clear the
          // tmux pointer — otherwise checkRunningSessions would double-process an
          // already-resolved session.
          const issue = getIssue(projectId, sourceId);
          if (issue) {
            markSessionSkipped(issue.id, reason);
            updateIssueStatus(projectId, sourceId, "queued");
            updateIssueTmux(projectId, sourceId, null);
          }
          return { success: true };
        }
        default:
          reply.code(400);
          return { error: `Unknown action "${action}"` };
      }
    } catch (err: any) {
      log.error(`Action ${action} failed for ${projectId}/${sourceId}: ${err.message}`);
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
