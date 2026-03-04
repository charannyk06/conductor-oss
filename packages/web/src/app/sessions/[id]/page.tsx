"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
  activePanel: "overview" | "diff" | "terminal";
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
  const searchParams = useSearchParams();
  const sessionId = params.id;
  const { theme, toggleTheme } = useTheme();
  const initialPanel = searchParams.get("tab") === "terminal" ? "terminal" : "overview";

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [messageInput, setMessageInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sentFeedback, setSentFeedback] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewSending, setReviewSending] = useState(false);
  const [killInProgress, setKillInProgress] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
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
    activePanel: initialPanel,
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

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "terminal") {
      setDiffState((prev) => (prev.activePanel === "terminal" ? prev : { ...prev, activePanel: "terminal" }));
    }
  }, [searchParams]);

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

  const handleCopyField = useCallback(async (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(label);
      setTimeout(() => setCopiedField((current) => (current === label ? null : current)), 1500);
    } catch {
      // ignore
    }
  }, []);

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

      {/* Main content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-2">
          <div className="flex items-center gap-1 rounded-md bg-[var(--color-bg-base)] p-0.5">
            <button
              onClick={() =>
                setDiffState((prev) => ({ ...prev, activePanel: "overview" }))
              }
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
                diffState.activePanel === "overview"
                  ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() =>
                setDiffState((prev) => ({ ...prev, activePanel: "diff" }))
              }
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
                diffState.activePanel === "diff"
                  ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              Diff
            </button>
            <button
              onClick={() =>
                setDiffState((prev) => ({ ...prev, activePanel: "terminal" }))
              }
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
                diffState.activePanel === "terminal"
                  ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              Terminal
            </button>
          </div>
          {diffState.activePanel === "diff" && (
            <button
              onClick={() => void fetchDiff()}
              disabled={diffState.loading}
              className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            >
              {diffState.loading ? "Refreshing..." : "Refresh diff"}
            </button>
          )}
        </div>

        {diffState.activePanel === "terminal" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <TerminalView sessionId={sessionId} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {diffState.activePanel === "overview" ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Summary</h2>
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                    {session.summary?.trim() || "No summary yet."}
                  </p>
                  {meta["prompt"] && (
                    <div className="mt-4 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-3">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Prompt</div>
                      <p className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                        {meta["prompt"]}
                      </p>
                    </div>
                  )}
                </section>

                <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Status</h2>
                  <div className="flex flex-wrap gap-2">
                    <InfoPill label="Status" value={session.status.replace(/_/g, " ")} tone="blue" />
                    <InfoPill label="Activity" value={session.activity ?? "-"} tone="violet" />
                    <InfoPill label="Attention" value={attentionLevel} tone={attentionLevel === "respond" || attentionLevel === "review" ? "amber" : "slate"} />
                  </div>
                </section>

                <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Agent</h2>
                  <div className="mb-3 flex items-center gap-2">
                    <AgentTileIcon
                      seed={{
                        label: agentDirectorySeed.label,
                        iconUrl: agentDirectorySeed.iconUrl,
                        homepage: agentDirectorySeed.homepage,
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{agentDirectorySeed.label}</span>
                  </div>
                  <div className="space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                    <MetaRow label="Type" value={meta["agent"] ?? "-"} />
                    {meta["model"] && <MetaRow label="Model" value={meta["model"]} />}
                    {meta["permissions"] && <MetaRow label="Permissions" value={meta["permissions"]} />}
                  </div>
                </section>

                {session.pr && (
                  <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                    <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Pull Request</h2>
                    <a
                      href={session.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mb-3 block text-[12px] font-medium text-[var(--color-accent)] hover:underline"
                    >
                      #{session.pr.number} — {session.pr.title}
                    </a>
                    <div className="grid grid-cols-2 gap-2">
                      <InfoPill label="State" value={session.pr.state} tone="violet" />
                      <InfoPill label="CI" value={session.pr.ciStatus} tone={session.pr.ciStatus === "failing" ? "amber" : "blue"} />
                      <InfoPill label="Review" value={session.pr.reviewDecision.replace(/_/g, " ")} tone={session.pr.reviewDecision === "changes_requested" ? "amber" : "slate"} />
                      <InfoPill label="Mergeable" value={session.pr.mergeability.mergeable ? "yes" : "no"} tone={session.pr.mergeability.mergeable ? "blue" : "amber"} />
                    </div>
                  </section>
                )}

                <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Git</h2>
                  <div className="space-y-2">
                    {session.branch && (
                      <MonoField
                        label="Branch"
                        value={session.branch}
                        copied={copiedField === "branch"}
                        onCopy={() => void handleCopyField("branch", session.branch)}
                      />
                    )}
                    {meta["baseBranch"] && (
                      <MonoField
                        label="Base"
                        value={meta["baseBranch"]}
                        copied={copiedField === "baseBranch"}
                        onCopy={() => void handleCopyField("baseBranch", meta["baseBranch"])}
                      />
                    )}
                    {meta["worktree"] && (
                      <MonoField
                        label="Worktree"
                        value={meta["worktree"]}
                        copied={copiedField === "worktree"}
                        onCopy={() => void handleCopyField("worktree", meta["worktree"])}
                      />
                    )}
                  </div>
                </section>

                <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Cost + Timing</h2>
                  <div className="grid grid-cols-2 gap-2">
                    <MetricBox label="Total">
                      {(cost?.estimatedCostUsd ?? cost?.totalUSD) != null
                        ? `$${((cost?.estimatedCostUsd ?? cost?.totalUSD) as number).toFixed(4)}`
                        : "-"}
                    </MetricBox>
                    <MetricBox label="Duration">{formatDuration(durationMs)}</MetricBox>
                    <MetricBox label="Input tokens">
                      {cost?.inputTokens != null ? cost.inputTokens.toLocaleString() : "-"}
                    </MetricBox>
                    <MetricBox label="Output tokens">
                      {cost?.outputTokens != null ? cost.outputTokens.toLocaleString() : "-"}
                    </MetricBox>
                  </div>
                  <div className="mt-3 space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                    <MetaRow label="Created" value={formatTimestamp(createdDate)} />
                    <MetaRow label="Last active" value={formatTimestamp(lastActivityDate)} />
                  </div>
                </section>

                <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Timeline</h2>
                  <div className="relative pl-4">
                    <div className="absolute left-0 top-0 h-full w-px bg-[var(--color-border-default)]" />
                    <TimelineEvent label="Created" time={formatTimestamp(createdDate)} color="var(--color-accent)" />
                    {session.pr && <TimelineEvent label="PR opened" time={`#${session.pr.number}`} color="var(--color-accent-violet)" />}
                    <TimelineEvent
                      label={session.status.replace(/_/g, " ")}
                      time={formatTimestamp(lastActivityDate)}
                      color={isTerminal ? "var(--color-text-muted)" : "var(--color-status-working)"}
                      active={!isTerminal}
                    />
                  </div>
                </section>
              </div>
            ) : (
              <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
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
                      {diffState.generatedAt ? `Updated ${formatTimestamp(new Date(diffState.generatedAt))}` : "Waiting for diff..."}
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
                              <div className="truncate text-[11px] text-[var(--color-text-secondary)]">
                                {file.path}
                              </div>
                              <span className="rounded-full px-1.5 py-0.5 text-[9px]" style={{ background: statusColor }}>
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

                  <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2">
                    <textarea
                      value={reviewDraft}
                      onChange={(event) => setReviewDraft(event.target.value)}
                      placeholder="Send review notes to this agent..."
                      className="min-h-[72px] w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                      rows={3}
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={() => void handleSendReview()}
                        disabled={reviewSending || !reviewDraft.trim()}
                        className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
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
                </div>

                <div className="min-h-0 overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
                  {activeDiffFile ? (
                    <>
                      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2 text-[10px] text-[var(--color-text-muted)]">
                        {activeDiffFile.path}
                      </div>
                      <div className="max-h-[72vh] overflow-auto">
                        <div className="font-mono text-[11px] leading-5">
                          {activeDiffFile.lines.map((line, idx) => (
                            <DiffLineRow
                              key={`${activeDiffFile.path}-${idx}`}
                              line={line}
                              wrapLines={diffState.wrapLines}
                            />
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="p-6 text-center text-[11px] text-[var(--color-text-muted)]">
                      Select a file to inspect its diff.
                    </div>
                  )}

                  {diffState.untracked.length > 0 && (
                    <div className="border-t border-[var(--color-border-subtle)] px-3 py-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Untracked files</div>
                      <ul className="space-y-1">
                        {diffState.untracked.map((file) => (
                          <li key={file} className="break-all font-mono text-[10px] text-[var(--color-text-secondary)]">
                            {file}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {diffState.truncated && (
                    <div className="border-t border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.1)] px-3 py-2 text-[10px] text-[var(--color-accent-orange)]">
                      Diff output truncated for display.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom input bar */}
      {!isTerminal && diffState.activePanel !== "terminal" && (
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
      {isTerminal && diffState.activePanel !== "terminal" && (
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

type InfoPillTone = "blue" | "violet" | "amber" | "slate";

function InfoPill({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: InfoPillTone;
}) {
  const toneClasses: Record<InfoPillTone, string> = {
    blue: "border-[rgba(59,130,246,0.3)] bg-[rgba(59,130,246,0.14)] text-[var(--color-accent)]",
    violet: "border-[rgba(139,92,246,0.32)] bg-[rgba(139,92,246,0.14)] text-[var(--color-accent-violet)]",
    amber: "border-[rgba(245,158,11,0.32)] bg-[rgba(245,158,11,0.14)] text-[var(--color-status-attention)]",
    slate: "border-[var(--color-border-default)] bg-[var(--color-bg-base)] text-[var(--color-text-secondary)]",
  };

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${toneClasses[tone]}`}>
      <span className="uppercase tracking-wide text-[9px] opacity-80">{label}</span>
      <span className="font-medium capitalize">{value}</span>
    </div>
  );
}

function MetricBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">{children}</div>
    </div>
  );
}

function MonoField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
        <button
          onClick={onCopy}
          className="rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="break-all font-mono text-[11px] text-[var(--color-text-secondary)]">{value}</div>
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
