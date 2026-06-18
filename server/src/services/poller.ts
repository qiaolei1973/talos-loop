import { getEnabledProjects, buildProjectContext, type ProjectConfig } from "../config.js";
import { upsertIssue, type Issue } from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { ProjectContext, IssueState, SubIssue } from "../types/plugin.js";
import { setProjectBoard } from "./boardSnapshot.js";
import { createLogger } from "./logger.js";

const log = createLogger("poller");

export interface IssueEntry {
  issue: Issue;
  projectId: string;
  projectType: string;
  sourceId: string;
  targetRepo: string;
  /** Standard state of the issue as read by list() (queued/processing/done). */
  state: IssueState;
  /** Downstream attention signals from list() (e.g. an unresolved review thread). */
  subIssues?: SubIssue[];
}

export interface PollResult {
  projectId: string;
  projectType: string;
  /**
   * Every active issue returned by list() (all stages, not just Ready). The
   * dispatcher routes each by `state`: queued → ready-skill dispatch, done with
   * an unresolved review subIssue → review-skill dispatch.
   */
  discovered: IssueEntry[];
  error?: string;
}

/**
 * Poll one project: read every active issue once via the plugin's list() (issue
 * #32 — the single read that replaced discover() + listBoard()), upsert each for
 * identity/display cache, and rebuild the in-memory board snapshot from the
 * standard `state`s (the display-status input).
 *
 * list() THROWS on a read failure (never returns []) so the failure surfaces as
 * a prominent `error` on the result instead of silently looking like an empty
 * board. On a throw the snapshot is simply not refreshed this cycle.
 */
async function pollProject(project: ProjectConfig): Promise<PollResult> {
  const discovered: IssueEntry[] = [];
  let displayName = project.projectType;

  try {
    const plugin = await resolvePlugin(project.projectType);
    const ctx = buildProjectContext(project, log);
    displayName = plugin.name;

    const rawIssues = await plugin.list(ctx);

    // The board snapshot is keyed per source id → standard state; list() already
    // narrowed to declared-repo issues, so every returned item is tracked.
    const slice = new Map<string, string>();
    for (const raw of rawIssues) {
      const issue = upsertIssue(project.projectId, project.projectType, raw.sourceId, raw.targetRepo, raw.url, raw.title);
      discovered.push({
        issue,
        projectId: project.projectId,
        projectType: project.projectType,
        sourceId: raw.sourceId,
        targetRepo: raw.targetRepo,
        state: raw.state,
        subIssues: raw.subIssues,
      });
      slice.set(raw.sourceId, raw.state);
    }
    setProjectBoard(project.projectId, slice);
  } catch (err: any) {
    log.error(`Error polling project "${project.projectId}": ${err.message}`);
    return { projectId: project.projectId, projectType: project.projectType, discovered, error: err.message };
  }

  log.info(`[${displayName}] ${discovered.length} active issue(s)`);
  return { projectId: project.projectId, projectType: project.projectType, discovered };
}

export async function pollAll(): Promise<PollResult[]> {
  const projects = getEnabledProjects();
  log.info(`Polling ${projects.length} project(s)...`);
  return Promise.all(projects.map(pollProject));
}
