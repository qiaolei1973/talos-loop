import { getEnabledSources, type SourceConfig } from "../config.js";
import { upsertIssue, updateIssueStatus, type Issue } from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { RawIssue, IssueStatus } from "../types/plugin.js";
import { createLogger } from "./logger.js";

const log = createLogger("poller");

export interface DiscoveredIssue {
  issue: Issue;
  sourceType: string;
  sourceId: string;
  targetRepo: string;
  labels: string[];
}

export interface PollResult {
  sourceType: string;
  discovered: DiscoveredIssue[];
  processing: DiscoveredIssue[];
  error?: string;
}

async function pollSource(source: SourceConfig): Promise<PollResult> {
  const discovered: DiscoveredIssue[] = [];
  const processing: DiscoveredIssue[] = [];

  try {
    const plugin = await resolvePlugin(source.type);
    const ctx = { config: source.config, logger: log };

    const rawIssues: RawIssue[] = await plugin.discover(ctx);

    for (const raw of rawIssues) {
      const issue = upsertIssue(raw.sourceType, raw.sourceId, raw.targetRepo, raw.url, raw.title);
      const status: IssueStatus = await plugin.getStatus(ctx, raw.sourceId);

      // Read trigger/processing labels from source config
      const triggerLabel = source.config.triggerLabel as string;
      const processingLabel = source.config.processingLabel as string;

      const entry: DiscoveredIssue = {
        issue,
        sourceType: raw.sourceType,
        sourceId: raw.sourceId,
        targetRepo: raw.targetRepo,
        labels: status.labels,
      };

      if (status.labels.includes(processingLabel)) {
        processing.push(entry);
        updateIssueStatus(raw.sourceType, raw.sourceId, "processing");
      } else if (status.labels.includes(triggerLabel)) {
        discovered.push(entry);
        updateIssueStatus(raw.sourceType, raw.sourceId, "queued");
      } else {
        // Issue exists but doesn't match trigger/processing — skip
      }
    }
  } catch (err: any) {
    log.error(`Error polling source "${source.type}": ${err.message}`);
    return { sourceType: source.type, discovered, processing, error: err.message };
  }

  log.info(`[${source.type}] ${discovered.length} queued, ${processing.length} processing`);
  return { sourceType: source.type, discovered, processing };
}

export async function pollAll(): Promise<PollResult[]> {
  const sources = getEnabledSources();
  log.info(`Polling ${sources.length} source(s)...`);
  return Promise.all(sources.map(pollSource));
}
