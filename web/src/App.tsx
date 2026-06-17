import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  ExternalLink,
  Terminal,
  CheckCircle,
  Clock,
  Loader2,
  GitBranch,
  Check,
  AlertTriangle,
  SkipForward,
  RotateCcw,
  Power,
} from "lucide-react";

interface Issue {
  id: number;
  project_id: string;
  project_type: string;
  project_name: string;
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
  /** issue #19: 'coding' (creates a PR) or 'review' (fixes review threads). */
  type?: "coding" | "review";
  /** issue #19: tmux process still alive — drives the per-session live + attach UI. */
  isLive?: boolean;
  /** issue #21: server-determined worktree path; present when a retry is possible. */
  worktree_path?: string | null;
  /** issue #30: captured claude -p session id; present when a `claude -r` resume is possible. */
  claude_session_id?: string | null;
}

interface Status {
  status: string;
  runningCount: number;
  maxParallel: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  pollInterval: number;
  projects?: { projectId: string; name: string; enabled: boolean }[];
}

const API = "";

/**
 * Each endpoint is its own query so they refresh independently: a slow
 * `/api/issues` response never blocks the `/api/status` header badge, and the
 * two cadences can be tuned separately. React Query handles the concerns that
 * `setInterval` + `Promise.all` used to do manually — request deduplication,
 * in-flight coalescing (a scheduled refetch is skipped while one is already
 * running), and stale-while-revalidate.
 */
async function fetchIssues(): Promise<Issue[]> {
  const res = await fetch(`${API}/api/issues`);
  if (!res.ok) throw new Error(`Failed to load issues (${res.status})`);
  return res.json();
}

async function fetchStatus(): Promise<Status> {
  const res = await fetch(`${API}/api/status`);
  if (!res.ok) throw new Error(`Failed to load status (${res.status})`);
  return res.json();
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: any; label: string; cls: string }> = {
    queued: { icon: Clock, label: "Ready", cls: "bg-yellow-100 text-yellow-800" },
    processing: { icon: Loader2, label: "In progress", cls: "bg-blue-100 text-blue-800" },
    done: { icon: CheckCircle, label: "In review", cls: "bg-green-100 text-green-800" },
    other: { icon: Clock, label: status, cls: "bg-gray-100 text-gray-800" },
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

/**
 * One session in an issue's session group (issue #19). Renders exactly one
 * state — the same logic the old latest-only SessionIndicator applied, now
 * applied to EVERY session (coding + each review cycle):
 *
 *   isLive               → pulsing dot + attach (any live session, coding or review)
 *   status failed/error  → AlertTriangle "infra error" + tooltip
 *   status skipped       → SkipForward "skipped" + tooltip
 *   status done          → neutral completed indicator
 *
 * The issue-level stage badge (StatusBadge) is decoupled and stays purely
 * board-driven — a live review session does NOT flip it to "In progress".
 */
function SessionChip({ session }: { session: Session }) {
  const typeLabel = session.type === "review" ? "review" : "coding";

  // Live: pulsing dot + an attach button on the row itself (user stories 8 & 10).
  if (session.isLive) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-green-50 px-1.5 py-0.5" title={`Live ${typeLabel} session`}>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        <span className="text-[10px] font-medium text-green-700">{typeLabel}</span>
        <AttachButton session={session.tmux_session} />
        <KillButton sessionId={session.id} />
      </span>
    );
  }
  if (session.status === "skipped") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700"
        title={session.error ?? "Agent skipped this issue — remove the skipped label on GitHub to re-enable"}
      >
        <SkipForward className="h-3 w-3" /> {typeLabel} · skipped
      </span>
    );
  }
  // issue #26: torn down from the dashboard — terminal, but distinct from an
  // infra failure. The worktree is preserved, so a killed coding session can be
  // retried from its partial work (the Retry button appears in the Actions cell).
  if (session.status === "killed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600"
        title={session.error ?? "Killed manually via the dashboard"}
      >
        <Power className="h-3 w-3" /> {typeLabel} · killed
        {session.claude_session_id && session.worktree_path && <ResumeButton sessionId={session.id} />}
      </span>
    );
  }
  if (session.status === "failed" || session.error) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
        title={session.error ?? "Infrastructure failure — will auto-retry"}
      >
        <AlertTriangle className="h-3 w-3" /> {typeLabel} · infra error
        {session.claude_session_id && session.worktree_path && <ResumeButton sessionId={session.id} />}
      </span>
    );
  }
  // Running-but-not-live: the DB row still reads "running" but tmux isn't
  // responding — a stuck/zombie process. Offer a kill to clear it.
  if (session.status === "running") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-yellow-50 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700"
        title="Session appears stuck (tmux not responding) — kill to clear it"
      >
        <Clock className="h-3 w-3" /> {typeLabel} · stuck
        <KillButton sessionId={session.id} />
      </span>
    );
  }
  // Neutral completed indicator (done).
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600" title={`${typeLabel} session · ${timeAgo(session.started_at)}`}>
      <CheckCircle className="h-3 w-3 text-gray-400" /> {typeLabel} · {timeAgo(session.started_at)}
      {session.claude_session_id && session.worktree_path && <ResumeButton sessionId={session.id} />}
    </span>
  );
}

/**
 * An issue's full session history (issue #19, user story 7): the coding session
 * plus zero or more review cycles, oldest → newest so it reads as a timeline.
 * Empty when no sessions have run yet.
 */
function SessionGroup({ sessions }: { sessions: Session[] }) {
  if (!sessions || sessions.length === 0) return <span className="text-gray-400">-</span>;
  // API returns started_at DESC; reverse for a chronological (oldest-first) view.
  const chronological = [...sessions].reverse();
  return (
    <div className="flex flex-col items-start gap-1">
      {chronological.map((s) => (
        <SessionChip key={s.id} session={s} />
      ))}
    </div>
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

/**
 * Kill a session's tmux window from the dashboard (issue #26). Tears down the
 * tmux process and marks the row `killed`; the backend leaves the worktree in
 * place so a killed coding session stays retryable. The endpoint is keyed by
 * the session DB id, so it targets exactly the row the button sits on.
 */
function KillButton({ sessionId }: { sessionId: number }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const handleKill = async () => {
    if (!window.confirm("Kill this session? Its tmux window will be destroyed (the worktree is kept).")) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/sessions/${sessionId}/kill`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`终止失败：${body.error ?? res.status}`);
      } else {
        // Refresh so the row re-renders as a `killed` chip (and, for a failed
        // coding session, surfaces the Retry button).
        await queryClient.invalidateQueries({ queryKey: ["issues"] });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleKill}
      disabled={busy}
      className="mr-2 inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-200 disabled:opacity-50 cursor-pointer"
      title="Kill the tmux session"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
      {busy ? "killing" : "kill"}
    </button>
  );
}

/**
 * Retry a failed coding session in place (issue #21): POST the retry action,
 * which dispatches a fresh agent into the failed session's preserved worktree.
 * The backend resolves the retry target (worktree + branch) from the failed
 * session, so this only needs the issue coordinates.
 */
function RetryButton({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const handleRetry = async () => {
    setBusy(true);
    try {
      const encoded = encodeURIComponent(projectId);
      const res = await fetch(`${API}/api/projects/${encoded}/issues/${sourceId}/actions/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`重试失败：${body.error ?? res.status}`);
      } else {
        // Refresh so the new retry session row appears in the session group.
        await queryClient.invalidateQueries({ queryKey: ["issues"] });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleRetry}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 disabled:opacity-50 cursor-pointer"
      title="Retry the failed session in its preserved worktree"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
      {busy ? "retrying" : "retry"}
    </button>
  );
}

/**
 * Copy a `claude -r <id>` resume command for an operator to run in their own
 * terminal (issue #30). `claude -r` is interactive/TTY-bound, so the server only
 * assembles the filled-in command (repo path, worktree, branch, session id) —
 * the operator pastes and runs it. Shown on any session that captured a claude
 * session id, so a running, failed, or done session can all be resumed/inspected.
 */
function ResumeButton({ sessionId }: { sessionId: number }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopy = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/sessions/${sessionId}/resume-command`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.command) {
        alert(`无法生成 resume 命令：${body.error ?? res.status}`);
        return;
      }
      await navigator.clipboard.writeText(body.command);
      setCopied(true);
      alert(`已复制到剪贴板（在你的终端执行）：\n\n${body.command}`);
      setTimeout(() => setCopied(false), 1500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleCopy}
      disabled={busy}
      className="mr-2 inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-200 disabled:opacity-50 cursor-pointer"
      title="复制 claude -r 恢复命令（在你的终端执行）"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : copied ? <Check className="h-3 w-3 text-green-600" /> : <RotateCcw className="h-3 w-3" />}
      {busy ? "…" : copied ? "copied!" : "resume"}
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
  const queryClient = useQueryClient();

  const issuesQuery = useQuery({
    queryKey: ["issues"],
    queryFn: fetchIssues,
    refetchInterval: 10_000, // refresh issue list every 10s
  });
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 30_000, // status is lightweight metadata — poll less often
  });

  const issues = issuesQuery.data ?? [];
  const status = statusQuery.data ?? null;

  // "Poll Now" feedback is user-initiated and distinct from background refresh,
  // so it gets its own flag rather than reusing isFetching (which would spin on
  // every interval tick). The button is disabled while any issues fetch is
  // in-flight so manual polls never stack on a pending one.
  const [polling, setPolling] = useState(false);
  const triggerPoll = async () => {
    setPolling(true);
    try {
      await fetch(`${API}/api/poll`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["issues"] });
    } finally {
      setPolling(false);
    }
  };
  const buttonBusy = polling || issuesQuery.isFetching;

  // Only the very first fetch (no data yet) shows a loading state; background
  // refetches update silently via stale-while-revalidate, so the UI doesn't
  // flicker on every poll cycle.
  const initialLoading = issuesQuery.isLoading;

  // Group issues by target_repo
  const byRepo = useMemo(
    () =>
      issues.reduce<Record<string, Issue[]>>((acc, issue) => {
        (acc[issue.target_repo] ??= []).push(issue);
        return acc;
      }, {}),
    [issues],
  );

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
              disabled={buttonBusy}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${polling ? "animate-spin" : ""}`} />
              Poll Now
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-5xl px-6 py-6">
        {initialLoading ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
            <Loader2 className="mx-auto mb-3 h-10 w-10 animate-spin text-gray-400" />
            <p className="text-gray-500">Loading issues…</p>
          </div>
        ) : Object.entries(byRepo).length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
            <GitBranch className="mx-auto mb-3 h-10 w-10 text-gray-400" />
            <p className="text-gray-500">No issues found yet.</p>
            <p className="mt-1 text-sm text-gray-400">
              Configure projects in <code className="rounded bg-gray-100 px-1">projects.json</code> to
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
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Project</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Status</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Sessions</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">PR</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Actions</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-600">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repoIssues.map((issue) => {
                      const sessions = issue.sessions ?? [];
                      // PR link: latest session that recorded a PR url (coding or
                      // review carry the same PR url; review-only rows reuse it).
                      const prSession = sessions.find((s) => s.pr_url) ?? null;
                      // issue #21: retry is offered when the LATEST session is a
                      // failed coding session whose worktree is preserved on disk.
                      // sessions[] is newest-first (API returns started_at DESC).
                      // issue #26: a `killed` session is retryable too — its
                      // worktree was left in place, so retry continues that work.
                      const latest = sessions[0];
                      const retryable =
                        !!latest &&
                        (latest.status === "failed" || latest.status === "killed") &&
                        latest.type !== "review" &&
                        !!latest.worktree_path;
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
                            <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-700">
                              {issue.project_name}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {/* Board-driven stage badge only (issue #19, user story 9):
                                a live review session does NOT change it. */}
                            <StatusBadge status={issue.status} />
                          </td>
                          <td className="px-4 py-3">
                            <SessionGroup sessions={sessions} />
                          </td>
                          <td className="px-4 py-3">
                            {prSession?.pr_url ? (
                              <a
                                href={prSession.pr_url}
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
                          <td className="px-4 py-3">
                            {retryable ? (
                              <RetryButton projectId={issue.project_id} sourceId={issue.source_id} />
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-500">{timeAgo(issue.updated_at)}</td>
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
