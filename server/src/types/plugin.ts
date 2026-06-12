import type { Logger } from "../services/logger.js";

export interface IssueSourcePlugin {
  name: string;
  init(ctx: SourceContext): Promise<void>;
  discover(ctx: SourceContext): Promise<RawIssue[]>;
  getStatus(ctx: SourceContext, sourceId: string): Promise<IssueStatus>;
  test(ctx: SourceContext): Promise<boolean>;
  onStatusChange?(ctx: SourceContext, sourceId: string, transition: StatusTransition): Promise<void>;
  onComment?(ctx: SourceContext, sourceId: string, comment: string): Promise<void>;
}

export interface SourceContext {
  config: Record<string, unknown>;
  logger: Logger;
}

export interface RawIssue {
  sourceType: string;
  sourceId: string;
  url: string;
  title: string;
  targetRepo: string;
  metadata?: Record<string, unknown>;
}

export interface IssueStatus {
  labels: string[];
}

export interface StatusTransition {
  from: string;
  to: string;
}
