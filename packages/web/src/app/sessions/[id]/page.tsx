"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import type { DashboardSession } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { TerminalView } from "@/components/TerminalView";
import { useTheme } from "@/components/ThemeProvider";
import { AgentTileIcon } from "@/components/AgentTileIcon";

type DiffLineKind = "meta" | "hunk" | "context" | "add" | "remove" | "info";

interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copy" | "binary" | "unknown";
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

interface DiffPayload {
  hasDiff: boolean;
  generatedAt: string;
  source: "working-tree" | "not-found";
  truncated: boolean;
  files: DiffFile[];
  untracked: string[];
  error?: string;
}

interface DiffUIState {
  files: DiffFile[];
  untracked: string[];
  loading: boolean;
  error: string | null;
  hasDiff: boolean;
  generatedAt: string;
  truncated: boolean;
  selectedFilePath: string | null;
  search: string;
  wrapLines: boolean;
  activePanel: "overview" | "diff";
}

type AgentCatalogEntry = {
  name: string;
  homepage: string | null;
  iconUrl: string | null;
};

type AgentDirectory = Record<string, Omit<AgentCatalogEntry, "name">>;

interface AgentsResponse {
  agents?: AgentCatalogEntry[];
}

function normalizeAgentName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;
  const { theme, toggleTheme } = useTheme();

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [messageInput, setMessageInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sentFeedback, setSentFeedback] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewSending, setReviewSending] = useState(false);
  const [killInProgress, setKillInProgress] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentDirectory, setAgentDirectory] = useState<AgentDirectory>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [diffState, setDiffState] = useState<DiffUIState>({
    files: [],
    untracked: [],
    loading: true,
    error: null,
    hasDiff: false,
    generatedAt: "",
    truncated: false,
    selectedFilePath: null,
    search: "",
    wrapLines: false,
    activePanel: "overview",
  });

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as DashboardSession;
      setSession(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const setDiffError = (error: string | null) =>
    setDiffState((prev) => ({ ...prev, error, loading: false, hasDiff: false }));

  const fetchDiff = useCallback(async () => {
    setDiffState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diff`);
      if (!res.ok) {
        const msg = `Unable to load diff (${res.status})`;
        setDiffError(msg);
        return;
      }

      const payload = (await res.json()) as DiffPayload;
      if (payload.error) {
        setDiffError(payload.error);
        return;
      }

      setDiffState((prev) => {
        const nextSelected =
          prev.selectedFilePath === null
            ? null
            : prev.selectedFilePath && payload.files.some((file) => file.path === prev.selectedFilePath)
            ? prev.selectedFilePath
            : payload.files[0]?.path ?? null;

        return {
          files: payload.files,
          untracked: payload.untracked,
          hasDiff: payload.hasDiff,
          truncated: payload.truncated,
          loading: false,
          error: null,
          generatedAt: payload.generatedAt,
          selectedFilePath: nextSelected,
          search: prev.search,
          wrapLines: prev.wrapLines,
          activePanel: prev.activePanel,
        };
      });
    } catch {
      setDiffError("Failed to load diff");
    }
  }, [sessionId]);

  const fetchAgentDirectory = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) return;
      const payload = (await res.json()) as AgentsResponse;
      if (!Array.isArray(payload.agents)) return;

      const nextDirectory: AgentDirectory = {};
      for (const agent of payload.agents) {
        const key = normalizeAgentName(agent.name);
        if (!key) continue;
        nextDirectory[key] = {
          homepage: agent.homepage ?? null,
          iconUrl: agent.iconUrl ?? null,
        };
      }
      setAgentDirectory(nextDirectory);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchSession();
    void fetchAgentDirectory();
    void fetchDiff();
    const interval = setInterval(() => void fetchSession(), 3000);
    const diffInterval = setInterval(() => void fetchDiff(), 8000);
    return () => {
      clearInterval(interval);
      clearInterval(diffInterval);
    };
  }, [fetchSession, fetchAgentDirectory, fetchDiff]);

  const handleSend = async () => {
    const msg = messageInput.trim();
    if (!msg) return;
    setSending(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      setMessageInput("");
      setSentFeedback(`Sent: "${msg.length > 50 ? msg.slice(0, 50) + "..." : msg}"`);
      setTimeout(() => setSentFeedback(null), 3000);
    } catch {
      // ignore
    }
    setTimeout(() => setSending(false), 500);
  };

  const handleSendReview = async () => {
    const draft = reviewDraft.trim();
    if (!draft || !session) return;
    setReviewSending(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: draft,
        }),
      });
      if (!res.ok) {
        setSentFeedback("Failed to send review notes");
        setTimeout(() => setSentFeedback(null), 2500);
        return;
      }
      setReviewDraft("");
      setSentFeedback("Sent review notes");
      setTimeout(() => setSentFeedback(null), 2500);
    } catch {
      setSentFeedback("Failed to send review notes");
      setTimeout(() => setSentFeedback(null), 2500);
    } finally {
      setReviewSending(false);
    }
  };

  const handleSpecialKey = async (key: string) => {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ special: key }),
      });
      setSentFeedback(`Sent: ${key}`);
      setTimeout(() => setSentFeedback(null), 2000);
    } catch {
      // ignore
    }
  };

  const isTerminal =
    session?.status === "merged" ||
    session?.status === "killed" ||
    session?.status === "done" ||
    session?.status === "terminated" ||
    session?.status === "cleanup";
  const action = isTerminal ? "Clean up" : "Kill";

  const handleKill = async () => {
    if (!confirm(`${action} session ${sessionId}?`)) return;
    if (killInProgress) return;
    setKillInProgress(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 404) {
        const detail = await res.text();
        const reason = detail || `Request failed with ${res.status}`;
        setActionError(`Unable to ${action.toLowerCase()} session ${sessionId}: ${reason}`);
        return;
      }
      if (isTerminal) {
        router.push("/");
      } else {
        void fetchSession();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setActionError(`Unable to ${action.toLowerCase()} session ${sessionId}: ${msg}`);
    } finally {
      setKillInProgress(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-accent)]" />
          <span className="text-sm text-[var(--color-text-muted)]">Loading session...</span>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-base)]">
        <svg width="32" height="32" viewBox="0 0 16 16" fill="var(--color-text-muted)"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zm9.78-3.97a.75.75 0 010 1.06L9.06 6.75l2.22 1.66a.75.75 0 11-.9 1.2L8 8.1l-2.38 1.51a.75.75 0 11-.9-1.2l2.22-1.66-2.22-1.66a.75.75 0 111.06-.88L8 5.9l2.22-1.81a.75.75 0 011.06.9z"/></svg>
        <p className="text-[14px] text-[var(--color-text-secondary)]">Session not found</p>
        <button onClick={() => router.push("/")} className="rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] transition-colors">
          ← Back to dashboard
        </button>
      </div>
    );
  }

  const attentionLevel = session ? getAttentionLevel(session) : "working";
  const meta = session?.metadata ?? {};
  const agentName = (meta["agent"] ?? "").trim();
  const runtimeHandle = (meta["runtimeHandle"] ?? "").trim();
  const agentDirectorySeed = (() => {
    const candidates = [agentName, runtimeHandle].filter(Boolean);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = normalizeAgentName(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const info = agentDirectory[key];
      if (info) {
        return {
          label: agentName || candidate,
          homepage: info.homepage,
          iconUrl: info.iconUrl,
        };
      }
    }

    return {
      label: agentName || runtimeHandle || "agent",
      iconUrl: null,
      homepage: null,
    };
  })();

  const diffSearch = diffState.search.trim().toLowerCase();
  const diffFiles = diffState.files.filter((file) => file.path.toLowerCase().includes(diffSearch));
  const activeDiffFile = diffState.selectedFilePath === null
    ? null
    : diffState.selectedFilePath
      ? diffFiles.find((file) => file.path === diffState.selectedFilePath) ?? diffFiles[0] ?? null
      : diffFiles[0] ?? null;

  // Parse cost from metadata
  interface CostInfo {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    totalUSD?: number;
  }
  let cost: CostInfo | null = null;
  if (meta["cost"]) {
    try {
      cost = JSON.parse(meta["cost"]) as CostInfo;
    } catch { /* ignore */ }
  }

  const createdDate = session ? new Date(session.createdAt) : new Date();
  const lastActivityDate = session ? new Date(session.lastActivityAt) : new Date();
  const durationMs = lastActivityDate.getTime() - createdDate.getTime();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--color-bg-base)]">
      {/* Header bar */}
      <header className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-2.5">
        <button
          onClick={() => router.push("/")}
          className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.75.75 0 010 1.06z" />
          </svg>
        </button>

        <span className="font-mono text-[13px] font-semibold text-[var(--color-text-primary)]">
          {sessionId}
        </span>

        {(agentName || runtimeHandle) && (
          <span className="inline-flex items-center gap-1.5 rounded bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
            <AgentTileIcon
              seed={{
                label: agentDirectorySeed.label,
                iconUrl: agentDirectorySeed.iconUrl,
                homepage: agentDirectorySeed.homepage,
              }}
              className="h-3.5 w-3.5"
            />
            {agentDirectorySeed.label}
          </span>
        )}

        {session && <StatusBadge status={session.status} />}

        {session?.pr && (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[var(--color-accent)] hover:underline"
          >
            PR #{session.pr.number}
          </a>
        )}

        <div className="flex-1" />

        <button
          onClick={toggleTheme}
          className="rounded-md border border-[var(--color-border-default)] p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)]"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0V.75A.75.75 0 018 0zm5.657 2.343a.75.75 0 010 1.06l-1.06 1.061a.75.75 0 11-1.061-1.06l1.06-1.061a.75.75 0 011.061 0zM16 8a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0116 8zm-2.343 5.657a.75.75 0 01-1.06 0l-1.061-1.06a.75.75 0 111.06-1.061l1.061 1.06a.75.75 0 010 1.061zM8 16a.75.75 0 01-.75-.75v-1.5a.75.75 0 011.5 0v1.5A.75.75 0 018 16zM2.343 13.657a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.061a.75.75 0 01-1.061 0zM0 8a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5H.75A.75.75 0 010 8zm2.343-5.657a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061L2.343 3.404a.75.75 0 010-1.061z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z" />
            </svg>
          )}
        </button>

        <button
          onClick={() => void handleKill()}
          disabled={killInProgress}
          className={`rounded-md border border-[rgba(239,68,68,0.3)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-status-error)] transition-colors hover:bg-[rgba(239,68,68,0.08)] ${
            killInProgress ? "cursor-wait opacity-50" : ""
          }`}
          title={actionError ?? `${action} this session`}
        >
          {killInProgress ? `${isTerminal ? "Cleaning" : "Killing"}...` : isTerminal ? "Cleanup" : "Kill"}
        </button>
      </header>

      {actionError && (
        <div className="border-b border-[var(--color-border-subtle)] bg-[rgba(239,68,68,0.12)] px-4 py-2 text-[11px] text-[var(--color-status-error)]">
          {actionError}
        </div>
      )}

      {/* Main content: Terminal + Metadata sidebar */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Terminal area */}
        <div className="flex-1 min-w-0">
          <TerminalView sessionId={sessionId} />
        </div>

        {/* Metadata sidebar */}
        {session && (
        <aside className="w-full border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] overflow-hidden flex flex-col lg:w-72 lg:shrink-0 lg:border-t-0 lg:border-l">
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2">
            <div className="flex items-center gap-1 rounded-md bg-[var(--color-bg-base)] p-0.5">
              <button
                onClick={() =>
                  setDiffState((prev) => ({ ...prev, activePanel: "overview" }))
                }
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${diffState.activePanel === "overview" ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]"}`}
              >
                Overview
              </button>
              <button
                onClick={() =>
                  setDiffState((prev) => ({ ...prev, activePanel: "diff" }))
                }
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${diffState.activePanel === "diff" ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]"}`}
              >
                Diff
              </button>
            </div>
            <button
              onClick={() => void fetchDiff()}
              disabled={diffState.loading}
              className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            >
              {diffState.loading ? "Refreshing..." : "Refresh diff"}
            </button>
          </div>

          <div className="px-4 py-2 text-[10px] text-[var(--color-text-muted)]">
            {diffState.loading && "Pulling latest code changes..."}
            {diffState.generatedAt && !diffState.loading ? `Updated ${formatTimestamp(new Date(diffState.generatedAt))}` : ""}
          </div>

          <div className="px-4 py-2 pb-4 overflow-auto">
            {diffState.activePanel === "overview" ? (
              <div className="space-y-5">
                {/* Summary */}
                {session.summary && (
                  <MetaSection label="Summary">
                    <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                      {session.summary}
                    </p>
                  </MetaSection>
                )}

                {/* Prompt */}
                {meta["prompt"] && (
                  <MetaSection label="Prompt">
                    <p className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)] font-mono">
                      {meta["prompt"]}
                    </p>
                  </MetaSection>
                )}

                {/* Status */}
                <MetaSection label="Status">
                  <div className="space-y-2">
                    <MetaRow label="Status" value={session.status.replace(/_/g, " ")} />
                    <MetaRow label="Activity" value={session.activity ?? "-"} />
                    <MetaRow label="Attention" value={attentionLevel} />
                  </div>
                </MetaSection>

                {/* Agent */}
                <MetaSection label="Agent">
                  {(agentName || runtimeHandle || meta["agent"]) && (
                    <div className="mb-2 flex items-center gap-2">
                      <AgentTileIcon
                        seed={{
                          label: agentDirectorySeed.label,
                          iconUrl: agentDirectorySeed.iconUrl,
                          homepage: agentDirectorySeed.homepage,
                        }}
                        className="h-3.5 w-3.5"
                      />
                      <span className="text-[12px] text-[var(--color-text-secondary)]">
                        {agentDirectorySeed.label}
                      </span>
                    </div>
                  )}
                  <MetaRow label="Type" value={meta["agent"] ?? "-"} />
                  {meta["model"] && <MetaRow label="Model" value={meta["model"]} />}
                  {meta["permissions"] && <MetaRow label="Permissions" value={meta["permissions"]} />}
                </MetaSection>

                {/* Git */}
                {(session.branch || meta["worktree"]) && (
                  <MetaSection label="Git">
                    {session.branch && (
                      <div className="text-[11px] font-mono text-[var(--color-text-secondary)] break-all">
                        {session.branch}
                        {session.pr ? ` ← ${session.pr.baseBranch || "main"}` : ""}
                      </div>
                    )}
                    {meta["baseBranch"] && (
                      <div className="text-[11px] font-mono text-[var(--color-text-muted)] mt-1">
                        Base: {meta["baseBranch"]}
                      </div>
                    )}
                    {meta["worktree"] && (
                      <div className="text-[11px] font-mono text-[var(--color-text-muted)] truncate mt-1">
                        {meta["worktree"]}
                      </div>
                    )}
                  </MetaSection>
                )}

                {/* PR */}
                {session.pr && (
                  <MetaSection label="Pull Request">
                    <a
                      href={session.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[12px] font-medium text-[var(--color-accent)] hover:underline block mb-2"
                    >
                      #{session.pr.number} — {session.pr.title}
                    </a>
                    <div className="space-y-1.5">
                      <MetaRow label="State" value={session.pr.state} />
                      <ColoredMetaRow
                        label="CI"
                        value={session.pr.ciStatus}
                        status={session.pr.ciStatus === "passing" ? "green" : session.pr.ciStatus === "failing" ? "red" : "amber"}
                      />
                      <ColoredMetaRow
                        label="Review"
                        value={session.pr.reviewDecision.replace(/_/g, " ")}
                        status={session.pr.reviewDecision === "approved" ? "green" : session.pr.reviewDecision === "changes_requested" ? "red" : "amber"}
                      />
                      <MetaRow
                        label="Mergeable"
                        value={session.pr.mergeability.mergeable ? "Yes" : "No"}
                      />
                    </div>

                    {/* Links */}
                    <div className="mt-2 space-y-1">
                      {session.pr.previewUrl && (
                        <a
                          href={session.pr.previewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline"
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                          Preview Deploy
                        </a>
                      )}
                      <a
                        href={`${session.pr.url}/checks`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] hover:underline hover:text-[var(--color-text-primary)]"
                      >
                        View CI Checks ↗
                      </a>
                      <a
                        href={`${session.pr.url}#pullrequestreview`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] hover:underline hover:text-[var(--color-text-primary)]"
                      >
                        View Reviews ↗
                      </a>
                    </div>

                    {session.pr.mergeability.blockers.length > 0 && (
                      <div className="mt-2 rounded-md bg-[rgba(239,68,68,0.06)] border border-[rgba(239,68,68,0.15)] p-2">
                        <div className="text-[10px] font-semibold text-[var(--color-status-error)] mb-1">Blockers</div>
                        {session.pr.mergeability.blockers.map((b, i) => (
                          <div key={i} className="text-[11px] text-[var(--color-text-secondary)]">
                            {b}
                          </div>
                        ))}
                      </div>
                    )}
                  </MetaSection>
                )}

                {/* Cost */}
                {cost && (
                  <MetaSection label="Cost">
                    <div className="space-y-1.5">
                      {(cost.estimatedCostUsd ?? cost.totalUSD) != null && (
                        <MetaRow
                          label="Total"
                          value={`$${((cost.estimatedCostUsd ?? cost.totalUSD) as number).toFixed(4)}`}
                        />
                      )}
                      {cost.inputTokens != null && (
                        <MetaRow label="Input" value={cost.inputTokens.toLocaleString()} />
                      )}
                      {cost.outputTokens != null && (
                        <MetaRow label="Output" value={cost.outputTokens.toLocaleString()} />
                      )}
                    </div>
                  </MetaSection>
                )}

                {/* Timing */}
                <MetaSection label="Timing">
                  <div className="space-y-1.5">
                    <MetaRow label="Created" value={formatTimestamp(createdDate)} />
                    <MetaRow label="Last Active" value={formatTimestamp(lastActivityDate)} />
                    <MetaRow label="Duration" value={formatDuration(durationMs)} />
                  </div>
                </MetaSection>

                {/* Timeline */}
                <MetaSection label="Timeline">
                  <div className="relative pl-4 border-l border-[var(--color-border-default)]">
                    <TimelineEvent
                      label="Created"
                      time={formatTimestamp(createdDate)}
                      color="var(--color-accent)"
                    />
                    {session.pr && (
                      <TimelineEvent
                        label="PR opened"
                        time={`#${session.pr.number}`}
                        color="var(--color-accent-violet)"
                      />
                    )}
                    <TimelineEvent
                      label={session.status.replace(/_/g, " ")}
                      time={formatTimestamp(lastActivityDate)}
                      color={
                        isTerminal
                          ? "var(--color-text-muted)"
                          : "var(--color-status-working)"
                      }
                      active={!isTerminal}
                    />
                  </div>
                </MetaSection>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative">
                  <input
                    value={diffState.search}
                    onChange={(e) =>
                      setDiffState((prev) => ({
                        ...prev,
                        search: e.target.value,
                        selectedFilePath: (() => {
                          const filteredFiles = prev.files.filter((file) =>
                            file.path.toLowerCase().includes(e.target.value.trim().toLowerCase()),
                          );

                          return prev.selectedFilePath && filteredFiles.find((file) => file.path === prev.selectedFilePath)
                            ? prev.selectedFilePath
                            : filteredFiles[0]?.path ?? null;
                        })(),
                      }))
                    }
                    placeholder="Filter files..."
                    className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 pr-16 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-[var(--color-text-muted)]">
                    {diffFiles.length} files
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setDiffState((prev) => ({ ...prev, wrapLines: !prev.wrapLines }))
                    }
                    className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                  >
                    {diffState.wrapLines ? "No wrap" : "Wrap lines"}
                  </button>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    {diffState.hasDiff || diffState.untracked.length > 0 ? "Live diff" : "No local changes"}
                  </div>
                </div>

                {diffState.error && (
                  <div className="rounded-md border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.12)] px-2.5 py-1.5 text-[10px] text-[var(--color-status-error)]">
                    {diffState.error}
                  </div>
                )}

                <div className="grid gap-2">
                  {diffFiles.length > 0 ? (
                    diffFiles.map((file) => {
                      const selected = file.path === activeDiffFile?.path;
                      const statusColor =
                        file.status === "added"
                          ? "rgba(34,197,94,0.16)"
                          : file.status === "deleted"
                            ? "rgba(239,68,68,0.16)"
                            : file.status === "renamed" || file.status === "copy"
                              ? "rgba(59,130,246,0.16)"
                              : file.status === "binary"
                                ? "rgba(217,119,6,0.16)"
                                : "rgba(63,63,70,0.25)";
                      return (
                        <button
                          key={file.path}
                          onClick={() =>
                            setDiffState((prev) => ({ ...prev, selectedFilePath: file.path }))
                          }
                          className={`rounded-md border px-2 py-1.5 text-left transition-colors ${
                            selected
                              ? "border-[var(--color-accent)] bg-[rgba(59,130,246,0.12)]"
                              : "border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[11px] text-[var(--color-text-secondary)] truncate">
                              {file.path}
                            </div>
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: statusColor }}>
                              {file.status}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                            +{file.additions} -{file.deletions}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
                      {diffState.hasDiff || diffState.untracked.length > 0
                        ? "Diff computed, but no file hunks were returned."
                        : "No changes yet"}
                    </div>
                  )}
                </div>

                {activeDiffFile && (
                  <div className="overflow-hidden border border-[var(--color-border-subtle)] rounded-md">
                    <div className="px-2 py-1.5 text-[10px] text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)] truncate">
                      {activeDiffFile.path}
                    </div>
                    <div className="overflow-auto max-h-72">
                      <div className="text-[11px] leading-5 font-mono">
                        {activeDiffFile.lines.map((line, idx) => (
                          <DiffLineRow
                            key={`${activeDiffFile.path}-${idx}`}
                            line={line}
                            wrapLines={diffState.wrapLines}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2">
                  <textarea
                    value={reviewDraft}
                    onChange={(event) => setReviewDraft(event.target.value)}
                    placeholder="Send review notes to this agent..."
                    className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] min-h-[72px]"
                    rows={3}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => void handleSendReview()}
                      disabled={reviewSending || !reviewDraft.trim()}
                      className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {reviewSending ? "Sending..." : "Send review notes"}
                    </button>
                    <button
                      onClick={() => setDiffState((prev) => ({ ...prev, selectedFilePath: null }))}
                      className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)]"
                    >
                      Clear selection
                    </button>
                  </div>
                </div>

                {diffState.untracked.length > 0 && (
                  <div className="rounded-md border border-[var(--color-border-subtle)] px-2 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                      Untracked files
                    </div>
                    <ul className="space-y-1">
                      {diffState.untracked.map((file) => (
                        <li key={file} className="text-[10px] text-[var(--color-text-secondary)] font-mono break-all">
                          {file}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {diffState.truncated && (
                  <div className="rounded-md border border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.1)] px-2 py-1.5 text-[10px] text-[var(--color-accent-orange)]">
                    Diff output truncated for display.
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
        )}
      </div>

      {/* Bottom input bar */}
      {!isTerminal && (
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
          {/* Quick action buttons */}
          <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 overflow-x-auto scrollbar-none">
            <span className="text-[10px] text-[var(--color-text-muted)] mr-1 shrink-0">Quick:</span>
            <QuickButton label="Accept" onClick={() => void handleSpecialKey("Enter")} />
            <QuickButton label="Esc" onClick={() => void handleSpecialKey("Escape")} />
            <QuickButton label="Ctrl+C" onClick={() => void handleSpecialKey("C-c")} />
            <QuickButton label="Yes" onClick={async () => {
              await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keys: "y" }),
              });
              await handleSpecialKey("Enter");
            }} />
            <QuickButton label="No" onClick={async () => {
              await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keys: "n" }),
              });
              await handleSpecialKey("Enter");
            }} />
            <div className="flex-1" />
            {sentFeedback && (
              <span className="shrink-0 text-[10px] text-[var(--color-status-ready)] animate-[pulse_1.5s_ease-in-out_infinite]">
                {sentFeedback}
              </span>
            )}
          </div>

          {/* Message input */}
          <div className="flex items-end gap-2 px-4 pb-3 pt-1" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
            <div className="flex-1 relative">
              <span className="absolute left-3 top-2.5 text-[var(--color-accent)] text-xs font-mono select-none opacity-50">
                &gt;
              </span>
              <textarea
                ref={inputRef}
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Message the agent..."
                rows={1}
                className="w-full rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-base)] pl-7 pr-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] font-mono outline-none focus:border-[var(--color-accent)] resize-none transition-colors"
                style={{ minHeight: "38px", maxHeight: "120px" }}
              />
            </div>
            <button
              onClick={() => void handleSend()}
              disabled={sending || messageInput.trim().length === 0}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-30 shrink-0"
            >
              {sending ? "..." : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* Terminal status footer for completed sessions */}
      {isTerminal && (
        <div
          className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-2.5 flex items-center gap-2"
          style={{ paddingBottom: "max(10px, env(safe-area-inset-bottom))" }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-muted)]" />
          <span className="text-[11px] text-[var(--color-text-muted)]">
            Session {session?.status} — read-only
          </span>
        </div>
      )}
    </div>
  );
}

function DiffLineRow({ line, wrapLines }: { line: DiffLine; wrapLines: boolean }) {
  const lineClassByKind: Record<DiffLineKind, string> = {
    hunk: "text-[var(--color-text-secondary)]",
    meta: "text-[var(--color-text-muted)]",
    add: "bg-[rgba(34,197,94,0.12)] text-[var(--color-status-ready)]",
    remove: "bg-[rgba(239,68,68,0.12)] text-[var(--color-status-error)]",
    context: "text-[var(--color-text-secondary)]",
    info: "text-[var(--color-text-muted)] italic",
  };

  const prefix =
    line.kind === "add"
      ? "+"
      : line.kind === "remove"
        ? "-"
        : line.kind === "hunk"
          ? "@"
          : line.kind === "context"
            ? " "
            : line.kind === "meta"
              ? "•"
              : " ";

  return (
    <div
      className={`flex items-start gap-2 px-2 py-0.5 text-[11px] ${lineClassByKind[line.kind]} ${
        wrapLines ? "whitespace-pre-wrap" : "whitespace-pre"
      }`}
    >
      <span className="w-12 shrink-0 text-right text-[9px] text-[var(--color-text-muted)] tabular-nums">
        {line.oldLine ?? ""}
      </span>
      <span className="w-12 shrink-0 text-right text-[9px] text-[var(--color-text-muted)] tabular-nums">
        {line.newLine ?? ""}
      </span>
      <span className="w-3 shrink-0 font-semibold text-[var(--color-text-primary)]">{prefix}</span>
      <pre className="m-0 min-w-0 flex-1">
        <span>{line.text === "" ? "\u00A0" : line.text}</span>
      </pre>
    </div>
  );
}

function MetaSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{label}</span>
      <span className="text-[11px] text-[var(--color-text-secondary)] text-right truncate capitalize">
        {value}
      </span>
    </div>
  );
}

function ColoredMetaRow({ label, value, status }: { label: string; value: string; status: "green" | "red" | "amber" }) {
  const colorMap = {
    green: "var(--color-status-ready)",
    red: "var(--color-status-error)",
    amber: "var(--color-status-attention)",
  };
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{label}</span>
      <span className="text-[11px] text-right truncate capitalize font-medium" style={{ color: colorMap[status] }}>
        {value}
      </span>
    </div>
  );
}

function TimelineEvent({
  label,
  time,
  color,
  active,
}: {
  label: string;
  time: string;
  color: string;
  active?: boolean;
}) {
  return (
    <div className="relative mb-3 last:mb-0">
      <span
        className={`absolute -left-[21px] top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-bg-surface)] ${
          active ? "animate-[pulse_2s_ease-in-out_infinite]" : ""
        }`}
        style={{ background: color }}
      />
      <div className="text-[11px] font-medium text-[var(--color-text-secondary)] capitalize">
        {label}
      </div>
      <div className="text-[10px] text-[var(--color-text-muted)]">{time}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    spawning: "var(--color-accent-blue)",
    working: "var(--color-accent-blue)",
    pr_open: "var(--color-accent-violet)",
    ci_failed: "var(--color-status-error)",
    review_pending: "var(--color-status-attention)",
    changes_requested: "var(--color-status-error)",
    approved: "var(--color-status-ready)",
    mergeable: "var(--color-status-ready)",
    merged: "var(--color-accent-violet)",
    needs_input: "var(--color-status-attention)",
    stuck: "var(--color-status-error)",
    errored: "var(--color-status-error)",
  };

  const color = colorMap[status] ?? "var(--color-text-muted)";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

function QuickButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 rounded-md border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]"
    >
      {label}
    </button>
  );
}

function formatTimestamp(d: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago (${timeStr})`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago (${timeStr})`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ` ${timeStr}`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "-";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
