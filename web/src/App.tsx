import { useEffect, useState, useCallback } from "react";
import {
  RefreshCw,
  ExternalLink,
  Terminal,
  RotateCcw,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  GitBranch,
  Check,
} from "lucide-react";

interface Issue {
  id: number;
  source_type: string;
  source_name: string;
  source_id: string;
  target_repo: string;
  url: string;
  title: string | null;
  status: string;
  tmux_session: string | null;
  sessions: Session[];
  created_at: string;
  updated_at: string;
}

interface Session {
  id: number;
  tmux_session: string;
  status: string;
  pr_url: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface Status {
  status: string;
  runningCount: number;
  maxParallel: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  pollInterval: number;
  sources?: { name: string; enabled: boolean }[];
}

const API = "";

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: any; label: string; cls: string }> = {
    queued: { icon: Clock, label: "Queued", cls: "bg-yellow-100 text-yellow-800" },
    processing: { icon: Loader2, label: "Processing", cls: "bg-blue-100 text-blue-800" },
    done: { icon: CheckCircle, label: "Done", cls: "bg-green-100 text-green-800" },
    failed: { icon: XCircle, label: "Failed", cls: "bg-red-100 text-red-800" },
    other: { icon: Clock, label: "Other", cls: "bg-gray-100 text-gray-800" },
  };
  const c = config[status] || config.other;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${c.cls}`}>
      <Icon className={`h-3 w-3 ${status === "processing" ? "animate-spin" : ""}`} />
      {c.label}
    </span>
  );
}

function SourceTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    github: "bg-gray-100 text-gray-700",
  };
  const cls = colors[type] || "bg-purple-100 text-purple-700";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {type}
    </span>
  );
}

function AttachButton({ session }: { session: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const cmd = `tmux attach -t ${session}`;
    await navigator.clipboard.writeText(cmd);
    setCopied(true);
    alert(`已复制到剪贴板:\n\n${cmd}`);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="mr-2 inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-200 cursor-pointer"
      title={`tmux attach -t ${session}`}
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Terminal className="h-3 w-3" />}
      {copied ? "copied!" : "attach"}
    </button>
  );
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "-";
  // SQLite datetime('now') returns UTC without 'Z' — append it so JS parses as UTC
  const d = new Date(dateStr.endsWith("Z") ? dateStr : dateStr + "Z");
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function App() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [issuesRes, statusRes] = await Promise.all([
        fetch(`${API}/api/issues`).then((r) => r.json()),
        fetch(`${API}/api/status`).then((r) => r.json()),
      ]);
      setIssues(issuesRes);
      setStatus(statusRes);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerPoll = async () => {
    setLoading(true);
    await fetch(`${API}/api/poll`, { method: "POST" });
    await fetchData();
  };

  const retryIssue = async (id: number) => {
    await fetch(`${API}/api/issues/${id}/retry`, { method: "POST" });
    await fetchData();
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  // Group issues by target_repo
  const byRepo = issues.reduce<Record<string, Issue[]>>((acc, issue) => {
    (acc[issue.target_repo] ??= []).push(issue);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <RefreshCw className="h-6 w-6 text-blue-600" />
            <h1 className="text-xl font-bold text-gray-900">Talos Loop</h1>
            {status && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                {status.runningCount > 0
                  ? `${status.runningCount}/${status.maxParallel} running`
                  : "idle"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {status && (
              <span className="text-sm text-gray-500">
                Last poll: {timeAgo(status.lastPollAt)}
              </span>
            )}
            <button
              onClick={triggerPoll}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Poll Now
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-5xl px-6 py-6">
        {Object.entries(byRepo).length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
            <GitBranch className="mx-auto mb-3 h-10 w-10 text-gray-400" />
            <p className="text-gray-500">No issues found yet.</p>
            <p className="mt-1 text-sm text-gray-400">
              Configure sources in <code className="rounded bg-gray-100 px-1">config.json</code> to
              get started.
            </p>
          </div>
        ) : (
          Object.entries(byRepo).map(([repo, repoIssues]) => (
            <div key={repo} className="mb-8">
              <div className="mb-3 flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-gray-500" />
                <h2 className="font-semibold text-gray-800">{repo}</h2>
                <span className="text-sm text-gray-400">{repoIssues.length} issues</span>
              </div>
              <div className="overflow-hidden rounded-lg border bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Issue</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Source</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Status</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">PR</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Updated</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repoIssues.map((issue) => {
                      const latestSession = issue.sessions?.[0];
                      return (
                        <tr key={issue.id} className="border-b last:border-0 hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <a
                              href={issue.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              #{issue.source_id}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            <span className="ml-2 text-gray-700">{issue.title}</span>
                          </td>
                          <td className="px-4 py-3">
                            <SourceTypeBadge type={issue.source_name} />
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={issue.status} />
                          </td>
                          <td className="px-4 py-3">
                            {latestSession?.pr_url ? (
                              <a
                                href={latestSession.pr_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                              >
                                PR <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-500">{timeAgo(issue.updated_at)}</td>
                          <td className="px-4 py-3 text-right">
                            {issue.status === "processing" && issue.tmux_session && (
                              <AttachButton session={issue.tmux_session} />
                            )}
                            {issue.status === "failed" && (
                              <button
                                onClick={() => retryIssue(issue.id)}
                                className="inline-flex items-center gap-1 rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 hover:bg-orange-200"
                              >
                                <RotateCcw className="h-3 w-3" />
                                retry
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
