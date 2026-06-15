import { getEnabledProjects, buildProjectContext, type ProjectConfig } from "../config.js";
import { upsertIssue, updateIssueStatus, type Issue } from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { RawIssue } from "../types/plugin.js";
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

async function pollProject(project: ProjectConfig): Promise<PollResult> {
  const discovered: IssueEntry[] = [];
  let displayName = project.projectType;

  try {
    const plugin = await resolvePlugin(project.projectType);
    const ctx = buildProjectContext(project, log);
    displayName = plugin.name;

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
      // issues are tracked by the sessions table, not re-discovered.
      updateIssueStatus(project.projectId, raw.sourceId, "queued");
    }
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
