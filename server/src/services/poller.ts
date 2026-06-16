import { getEnabledProjects, buildProjectContext, loadConfig, type ProjectConfig } from "../config.js";
import { upsertIssue, type Issue } from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { BoardItem, ProjectContext, RawIssue } from "../types/plugin.js";
import { setProjectBoard } from "./boardSnapshot.js";
import { createLogger } from "./logger.js";

const log = createLogger("poller");

export interface IssueEntry {
  issue: Issue;
  projectId: string;
  projectType: string;
  sourceId: string;
  targetRepo: string;
}

export interface PollResult {
  projectId: string;
  projectType: string;
  discovered: IssueEntry[];
  error?: string;
}

/**
 * Rebuild the in-memory board snapshot for one project from the plugin's full
 * board listing. Only items whose repo is declared are tracked (others have no
 * issues-table row to derive against — discover() already comments on the drift).
 * A board-read failure is logged prominently rather than swallowed; the snapshot
 * simply isn't refreshed this cycle.
 */
async function refreshBoardSnapshot(
  ctx: ProjectContext,
  plugin: { listBoard(ctx: ProjectContext): Promise<BoardItem[]> },
  projectId: string,
): Promise<void> {
  let items: BoardItem[];
  try {
    items = await plugin.listBoard(ctx);
  } catch (err: any) {
    log.warn(`[${projectId}] board read failed — snapshot not refreshed: ${err.message}`);
    return;
  }

  const slice = new Map<string, string>();
  for (const item of items) {
    const repo = ctx.repos.find((r) => r.remote === item.repository);
    if (!repo) continue; // config drift — discover() already notified
    slice.set(item.sourceId, item.boardStatus);
  }
  setProjectBoard(projectId, slice);
}

async function pollProject(project: ProjectConfig): Promise<PollResult> {
  const discovered: IssueEntry[] = [];
  let displayName = project.projectType;

  try {
    const plugin = await resolvePlugin(project.projectType);
    const ctx = buildProjectContext(project, log);
    displayName = plugin.name;

    // Quota gate: probe the shared GraphQL budget BEFORE spending it. talos-loop
    // and the dispatched agent share one token; when the agent has run the budget
    // low, skip this cycle's board read instead of slamming into a hard
    // rate-limit error. A failed probe falls through (never blocks polling).
    if (typeof plugin.checkQuota === "function") {
      const quota = await plugin.checkQuota(ctx);
      if (!quota.available) {
        log.warn(`[${project.projectId}] 配额探测失败（${quota.error}），保守放行本轮 board 轮询`);
      } else if ((quota.remaining ?? 0) < loadConfig().quotaThreshold) {
        log.warn(
          `[${project.projectId}] GraphQL 配额不足：剩余 ${quota.remaining}/${quota.limit}（reset ${quota.resetAt?.toISOString()}）< 阈值 ${loadConfig().quotaThreshold}，跳过本轮 board 轮询`,
        );
        return { projectId: project.projectId, projectType: project.projectType, discovered };
      }
    }

    const rawIssues: RawIssue[] = await plugin.discover(ctx);

    for (const raw of rawIssues) {
      const issue = upsertIssue(project.projectId, project.projectType, raw.sourceId, raw.targetRepo, raw.url, raw.title);
      discovered.push({
        issue,
        projectId: project.projectId,
        projectType: project.projectType,
        sourceId: raw.sourceId,
        targetRepo: raw.targetRepo,
      });
      // discover() returns only ready-to-dispatch issues (state queued). In-flight
      // issues are tracked by the sessions table, not re-discovered. Workflow
      // status is no longer persisted here (issue #13) — it is derived from the
      // board snapshot refreshed below + the sessions table.
    }

    // The board is the single source of workflow truth; refresh the in-memory
    // snapshot every cycle so the dashboard derives live status.
    await refreshBoardSnapshot(ctx, plugin, project.projectId);
  } catch (err: any) {
    log.error(`Error polling project "${project.projectId}": ${err.message}`);
    return { projectId: project.projectId, projectType: project.projectType, discovered, error: err.message };
  }

  log.info(`[${displayName}] ${discovered.length} ready issue(s)`);
  return { projectId: project.projectId, projectType: project.projectType, discovered };
}

export async function pollAll(): Promise<PollResult[]> {
  const projects = getEnabledProjects();
  log.info(`Polling ${projects.length} project(s)...`);
  return Promise.all(projects.map(pollProject));
}
