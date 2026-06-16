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
  setSessionBranch,
  type Issue,
} from "../db/index.js";
import { pollAll } from "../services/poller.js";
import { dispatch } from "../services/dispatcher.js";
import { resolvePlugin, getPluginName } from "../plugins/loader.js";
import { getBoardStatus, setBoardStatus } from "../services/boardSnapshot.js";
import { deriveDisplayState, liveSessionName, isSessionLive } from "../services/displayState.js";
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

  // All issues — `status` and `tmux_session` are DERIVED (issue #13), never read
  // from a persisted column: status comes from the board snapshot + live session
  // check; the attach target is the alive running session's name, if any.
  // Each session row also carries an `isLive` flag (issue #19) so the dashboard
  // can offer an attach button on any live session, coding or review, while the
  // issue's stage badge stays purely board-driven.
  app.get("/api/issues", async () => {
    const issues = await withProjectName(getAllIssues());
    return issues.map((issue) => {
      const sessions = getSessionsByIssue(issue.id);
      const boardStatus = getBoardStatus(issue.project_id, issue.source_id);
      return {
        ...issue,
        status: deriveDisplayState(sessions, boardStatus),
        tmux_session: liveSessionName(sessions),
        sessions: sessions.map((s) => ({ ...s, isLive: isSessionLive(s) })),
      };
    });
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
          // Record both the PR url AND its head branch (issue #19): a later
          // dispatchReview() pushes fixes to this same branch.
          if (issue) {
            setSessionPrUrl(issue.id, prUrl);
            setSessionBranch(issue.id, branch);
          }
          return { success: true, prUrl };
        }
        case "comment": {
          const message = body.message as string | undefined;
          if (!targetRepo || !message) return { error: "targetRepo and message required" };
          if (!plugin.onComment) return { error: "Plugin does not support comments" };
          await plugin.onComment(ctx, sourceId, message, targetRepo);
          return { success: true };
        }
        case "resolve-thread": {
          // issue #19: the review-fix agent resolves a PR review thread after
          // addressing it. The agent supplies the PR url and the thread node id
          // (both are in its prompt); the plugin performs the source-specific
          // resolution (GitHub: the GraphQL resolveReviewThread mutation).
          const prUrl = body.prUrl as string | undefined;
          const threadId = body.threadId as string | undefined;
          if (!targetRepo || !prUrl || !threadId) return { error: "targetRepo, prUrl and threadId required" };
          if (!plugin.resolveThread) return { error: "Plugin does not support resolve-thread" };
          await plugin.resolveThread(ctx, sourceId, prUrl, threadId);
          return { success: true };
        }
        case "skip": {
          if (!targetRepo) return { error: "targetRepo required" };
          const reason = (body.reason as string | undefined) ?? "No reason provided";
          await plugin.skip(ctx, sourceId, targetRepo, reason);
          // Coordination: mark the running session skipped so checkRunningSessions
          // doesn't double-process an already-resolved session. Workflow status is
          // not persisted (issue #13) — the board move happened in plugin.skip(),
          // and we optimistically mirror it to "Ready" for a snappy dashboard.
          const issue = getIssue(projectId, sourceId);
          if (issue) {
            markSessionSkipped(issue.id, reason);
            setBoardStatus(projectId, sourceId, "Ready");
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
