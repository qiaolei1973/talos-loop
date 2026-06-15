import { getEnabledSources, buildSourceContext, type SourceConfig } from "../config.js";
import { upsertIssue, updateIssueStatus, type Issue } from "../db/index.js";
import { resolvePlugin } from "../plugins/loader.js";
import type { RawIssue } from "../types/plugin.js";
import { createLogger } from "./logger.js";

const log = createLogger("poller");

export interface IssueEntry {
  issue: Issue;
  sourceType: string;
  sourceId: string;
  targetRepo: string;
}

export interface PollResult {
  sourceType: string;
  discovered: IssueEntry[];
  processing: IssueEntry[];
  error?: string;
}

async function pollSource(source: SourceConfig): Promise<PollResult> {
  const discovered: IssueEntry[] = [];
  const processing: IssueEntry[] = [];

  let sourceName: string = source.type;
  try {
    const plugin = await resolvePlugin(source.type);
    const ctx = buildSourceContext(source, log);
    sourceName = plugin.name;

    const rawIssues: RawIssue[] = await plugin.discover(ctx);

    for (const raw of rawIssues) {
      const issue = upsertIssue(source.type, raw.sourceId, raw.targetRepo, raw.url, raw.title);

      const entry: IssueEntry = {
        issue,
        sourceType: source.type,
        sourceId: raw.sourceId,
        targetRepo: raw.targetRepo,
      };

      // Bucket by the standard state the plugin already resolved at discovery
      // time. Core does not read any source-specific config or re-query status.
      if (raw.state === "processing") {
        processing.push(entry);
        updateIssueStatus(source.type, raw.sourceId, "processing");
      } else if (raw.state === "queued") {
        discovered.push(entry);
        updateIssueStatus(source.type, raw.sourceId, "queued");
      }
    }
  } catch (err: any) {
    log.error(`Error polling source "${sourceName}": ${err.message}`);
    return { sourceType: source.type, discovered, processing, error: err.message };
  }

  log.info(`[${sourceName}] ${discovered.length} queued, ${processing.length} processing`);
  return { sourceType: source.type, discovered, processing };
}

export async function pollAll(): Promise<PollResult[]> {
  const sources = getEnabledSources();
  log.info(`Polling ${sources.length} source(s)...`);
  return Promise.all(sources.map(pollSource));
}
