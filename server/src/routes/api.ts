import { FastifyInstance } from "fastify";
import { loadConfig, getEnabledProjects, loadProjects, getProjectById } from "../config.js";
import {
  getAllIssues,
  getIssuesByTargetRepo,
  getSessionsByIssue,
  getSessionById,
  getIssueById,
  getRunningSessions,
  updateSessionStatus,
  getAllSettings,
  upsertSetting,
  deleteSetting,
  type Issue,
} from "../db/index.js";
import { pollAll } from "../services/poller.js";
import { dispatch } from "../services/dispatcher.js";
import { getPluginName, getPluginSchemas } from "../plugins/loader.js";
import { getBoardStatus } from "../services/boardSnapshot.js";
import { deriveDisplayState, liveSessionName, isSessionLive } from "../services/displayState.js";
import * as tmux from "../services/tmux.js";
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

/**
 * Assemble the operator-run resume command for a session (issue #30). `claude -r`
 * is interactive and owns a TTY, so the server cannot run it — it returns a
 * filled-in command for the operator to paste into their own terminal.
 *
 *   git -C <repo_path> worktree add <worktree_path> <branch> 2>/dev/null; cd <worktree_path> && claude -r <claude_session_id>
 *
 * The `worktree add` is idempotent: a failed session's worktree still exists → the
 * add errors (silenced by 2>/dev/null) and we just cd+resume; a done session's
 * worktree was cleaned up → the add recreates it at the same path on the same
 * branch, then we resume. Requires the feat branch to still exist (it does while
 * the PR is open). The command deliberately omits --dangerously-skip-permissions
 * — a human resuming keeps the permission prompts.
 */
export function buildResumeCommand(parts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  claudeSessionId: string;
}): string {
  const { repoPath, worktreePath, branch, claudeSessionId } = parts;
  return `git -C ${repoPath} worktree add ${worktreePath} ${branch} 2>/dev/null; cd ${worktreePath} && claude -r ${claudeSessionId}`;
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

  // issue #26: manually tear down a session's tmux window from the dashboard.
  // Targets a session by its DB id (an issue may have several). Kills the tmux
  // process (a no-op if already dead — e.g. a zombie running row) and marks the
  // row `killed` so it reads as terminal and checkRunningSessions does not later
  // re-classify the now-dead process. The worktree is deliberately LEFT in place
  // (mirrors the failed-session policy): a killed coding session stays retryable.
  app.post("/api/sessions/:id/kill", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionId = parseInt(id, 10);
    const session = getSessionById(sessionId);
    if (!session) {
      reply.code(404);
      return { error: "Session not found" };
    }
    tmux.killSession(session.tmux_session);
    const wasRunning = session.status === "running";
    if (wasRunning) {
      updateSessionStatus(sessionId, "killed", "Killed via dashboard");
    }
    return { success: true, status: wasRunning ? "killed" : session.status };
  });

  // issue #30: assemble a `claude -r <id>` resume command for an operator to run
  // in their own terminal. The server can't run it (interactive / TTY), so it
  // fills in the authoritative values — repo path (from the project's repo), the
  // session's worktree+branch, and the captured claude session id — and the
  // dashboard's "copy resume command" button hands the string to the operator.
  // Pre-issue-#30 sessions (no captured id) and rows missing worktree/branch are
  // reported as not resumable rather than emitting a malformed command.
  app.get("/api/sessions/:id/resume-command", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSessionById(parseInt(id, 10));
    if (!session) {
      reply.code(404);
      return { error: "Session not found" };
    }
    if (!session.claude_session_id) {
      reply.code(409);
      return { error: "Session has no captured claude session id" };
    }
    if (!session.worktree_path || !session.branch) {
      reply.code(409);
      return { error: "Session is missing worktree/branch — cannot rebuild a worktree to resume into" };
    }
    const issue = getIssueById(session.issue_id);
    if (!issue) {
      reply.code(404);
      return { error: "Issue not found" };
    }
    const repo = getProjectById(issue.project_id)?.repos.find((r) => r.name === issue.target_repo);
    if (!repo) {
      reply.code(404);
      return { error: `Repo "${issue.target_repo}" not found` };
    }
    return {
      command: buildResumeCommand({
        repoPath: repo.path,
        worktreePath: session.worktree_path,
        branch: session.branch,
        claudeSessionId: session.claude_session_id,
      }),
    };
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

  // ---- Settings endpoints ----

  // List all settings grouped by plugin, values masked (show only last 4 chars)
  app.get("/api/settings", async () => {
    const all = getAllSettings();
    const grouped: Record<string, Array<{ key: string; value: string; plugin: string; updated_at: string }>> = {};
    for (const s of all) {
      const plugin = s.plugin;
      if (!grouped[plugin]) grouped[plugin] = [];
      grouped[plugin].push({
        ...s,
        value: s.value.length > 4 ? "•".repeat(s.value.length - 4) + s.value.slice(-4) : "••••",
      });
    }
    return grouped;
  });

  // Upsert a single setting. Body: { value: string, plugin: string }
  app.put("/api/settings/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = request.body as { value?: string; plugin?: string };
    if (!body.value || !body.plugin) {
      reply.code(400);
      return { error: "Body must contain 'value' and 'plugin'" };
    }
    const setting = upsertSetting(key, body.value, body.plugin);
    return setting;
  });

  // Delete a setting by key
  app.delete("/api/settings/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    const deleted = deleteSetting(key);
    if (!deleted) {
      reply.code(404);
      return { error: "Setting not found" };
    }
    return { success: true };
  });

  // Return schemas from all loaded plugins (drives the Settings UI form)
  app.get("/api/plugins/schemas", async () => {
    return getPluginSchemas();
  });
}
