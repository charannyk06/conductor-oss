"use client";

import { diffLines } from "diff";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileCode2,
  GitCompare,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { getDisplaySessionId } from "@/lib/bridgeSessionIds";
import { cn } from "@/lib/cn";
import { subscribeToSnapshotEvents } from "@/lib/liveEvents";
import { TERMINAL_STATUSES, type SSESessionEvent } from "@/lib/types";

type ReviewDiffSource = "working-tree" | "remote-pr" | "not-found";
type ReviewDiffStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copy"
  | "binary"
  | "untracked"
  | "unknown";
type DiffCategory = "against-base" | "staged" | "unstaged" | "untracked";
type DiffViewMode = "side-by-side" | "inline";
type DiffSideKind = "context" | "add" | "remove" | "empty";

interface ChangedFileSummary {
  path: string;
  oldPath?: string | null;
  status: ReviewDiffStatus;
  additions: number;
  deletions: number;
}

interface ReviewDiffSections {
  againstBase: ChangedFileSummary[];
  staged: ChangedFileSummary[];
  unstaged: ChangedFileSummary[];
  untracked: ChangedFileSummary[];
}

interface ReviewDiffPayload {
  hasDiff: boolean;
  generatedAt: string;
  source: ReviewDiffSource;
  truncated: boolean;
  branch?: string;
  defaultBranch?: string;
  files?: ChangedFileSummary[];
  untracked?: string[];
  sections?: Partial<ReviewDiffSections>;
}

interface FileContentsPayload {
  path: string;
  oldPath?: string | null;
  status: ReviewDiffStatus;
  category: DiffCategory;
  baseBranch?: string;
  binary: boolean;
  truncated: boolean;
  originalSize: number;
  modifiedSize: number;
  original: string | null;
  modified: string | null;
}

interface FileContentsState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  data: FileContentsPayload | null;
}

interface SessionDiffProps {
  sessionId: string;
  active: boolean;
}

interface FileEntry {
  category: DiffCategory;
  file: ChangedFileSummary;
  fileKey: string;
}

interface SplitDiffRow {
  kind: "content" | "skip";
  oldKind: DiffSideKind;
  newKind: DiffSideKind;
  oldLine: number | null;
  newLine: number | null;
  oldText: string;
  newText: string;
  message?: string;
}

interface InlineDiffRow {
  kind: "content" | "skip";
  lineKind: "context" | "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  message?: string;
}

const EMPTY_FILE_STATE: FileContentsState = {
  loading: false,
  loaded: false,
  error: null,
  data: null,
};

const EMPTY_SECTIONS: ReviewDiffSections = {
  againstBase: [],
  staged: [],
  unstaged: [],
  untracked: [],
};

const EMPTY_PAYLOAD: ReviewDiffPayload = {
  hasDiff: false,
  generatedAt: "",
  source: "not-found",
  truncated: false,
  branch: "",
  defaultBranch: "",
  files: [],
  untracked: [],
  sections: EMPTY_SECTIONS,
};

const ACTIVE_DIFF_REFRESH_MS = 15_000;
const HIDDEN_DIFF_REFRESH_MS = 30_000;
const CONTEXT_RADIUS = 3;
const STORAGE_KEYS = {
  viewMode: "conductor-session-diff-view-mode",
  hideUnchanged: "conductor-session-diff-hide-unchanged",
};
const SECTION_ORDER: DiffCategory[] = ["against-base", "staged", "unstaged", "untracked"];
const SECTION_TITLES: Record<DiffCategory, string> = {
  "against-base": "Against base",
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};

function normalizePath(path: unknown): string {
  if (typeof path !== "string") return "";
  const compact = path.trim().replace(/^\/+/, "").replace(/\/+/g, "/");
  return compact;
}

function coerceStatus(value: unknown): ReviewDiffStatus {
  if (
    value === "modified" ||
    value === "added" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "copy" ||
    value === "binary" ||
    value === "untracked"
  ) {
    return value;
  }
  return "unknown";
}

function normalizeChangedFile(value: Partial<ChangedFileSummary>): ChangedFileSummary | null {
  const path = normalizePath(value.path);
  if (!path) return null;
  return {
    path,
    oldPath: normalizePath(value.oldPath ?? "") || null,
    status: coerceStatus(value.status),
    additions: Number.isFinite(value.additions) ? Math.max(0, Number(value.additions)) : 0,
    deletions: Number.isFinite(value.deletions) ? Math.max(0, Number(value.deletions)) : 0,
  };
}

function normalizeSections(payload: ReviewDiffPayload): ReviewDiffSections {
  const normalizeList = (files: unknown): ChangedFileSummary[] => {
    if (!Array.isArray(files)) return [];
    return files
      .map((file) => normalizeChangedFile(file as Partial<ChangedFileSummary>))
      .filter((file): file is ChangedFileSummary => file !== null);
  };

  const againstBase = normalizeList(payload.sections?.againstBase ?? payload.files ?? []);
  const staged = normalizeList(payload.sections?.staged ?? []);
  const unstaged = normalizeList(payload.sections?.unstaged ?? []);
  const untracked = normalizeList(payload.sections?.untracked ?? []).concat(
    Array.isArray(payload.untracked)
      ? payload.untracked
        .map((path) => normalizeChangedFile({
          path,
          status: "untracked",
          additions: 0,
          deletions: 0,
        }))
        .filter((file): file is ChangedFileSummary => file !== null)
      : [],
  );

  const dedupe = (files: ChangedFileSummary[]) => {
    const map = new Map<string, ChangedFileSummary>();
    for (const file of files) {
      map.set(`${file.path}:${file.oldPath ?? ""}:${file.status}`, file);
    }
    return [...map.values()].sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  };

  return {
    againstBase: dedupe(againstBase),
    staged: dedupe(staged),
    unstaged: dedupe(unstaged),
    untracked: dedupe(untracked),
  };
}

function getSectionFiles(sections: ReviewDiffSections, category: DiffCategory): ChangedFileSummary[] {
  if (category === "against-base") {
    return sections.againstBase;
  }
  return sections[category];
}

function createFileKey(category: DiffCategory, file: ChangedFileSummary): string {
  return `${category}:${file.oldPath ?? ""}:${file.path}`;
}

function sourceLabel(source: ReviewDiffSource): string {
  if (source === "working-tree") return "Working tree";
  if (source === "remote-pr") return "Remote PR";
  return "Not found";
}

function formatGeneratedAt(value: string): string {
  if (!value) return "Not generated";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not generated";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(parsed);
}

function statusLabel(file: ChangedFileSummary): string {
  if (file.status === "added") return "Added";
  if (file.status === "deleted") return "Deleted";
  if (file.status === "renamed") return "Renamed";
  if (file.status === "copy") return "Copied";
  if (file.status === "binary") return "Binary";
  if (file.status === "untracked") return "Untracked";
  if (file.status === "modified") return "Modified";
  return "Changed";
}

function statusPillClass(file: ChangedFileSummary): string {
  if (file.status === "added" || file.status === "untracked") {
    return "border-[rgba(84,176,79,0.35)] bg-[rgba(84,176,79,0.08)] text-[var(--vk-green)]";
  }
  if (file.status === "deleted") {
    return "border-[rgba(210,81,81,0.35)] bg-[rgba(210,81,81,0.08)] text-[var(--vk-red)]";
  }
  if (file.status === "renamed" || file.status === "copy") {
    return "border-[rgba(108,168,255,0.35)] bg-[rgba(108,168,255,0.08)] text-[var(--status-working)]";
  }
  if (file.status === "binary") {
    return "border-[rgba(210,160,59,0.35)] bg-[rgba(210,160,59,0.08)] text-[var(--status-attention)]";
  }
  return "border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] text-[var(--vk-text-muted)]";
}

function readStoredViewMode(): DiffViewMode {
  if (typeof window === "undefined") return "inline";
  const value = window.localStorage.getItem(STORAGE_KEYS.viewMode);
  return value === "side-by-side" ? "side-by-side" : "inline";
}

function readStoredHideUnchanged(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEYS.hideUnchanged) === "true";
}

function formatSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function toDiffLines(value: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function createContentRow(
  oldKind: DiffSideKind,
  newKind: DiffSideKind,
  oldLine: number | null,
  newLine: number | null,
  oldText: string,
  newText: string,
): SplitDiffRow {
  return {
    kind: "content",
    oldKind,
    newKind,
    oldLine,
    newLine,
    oldText,
    newText,
  };
}

function buildSplitDiffRows(original: string, modified: string): SplitDiffRow[] {
  const changes = diffLines(original, modified);
  const rows: SplitDiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const lines = toDiffLines(change.value);

    if (change.removed) {
      const next = changes[index + 1];
      const nextLines = next?.added ? toDiffLines(next.value) : [];
      const pairCount = Math.max(lines.length, nextLines.length);

      for (let lineIndex = 0; lineIndex < pairCount; lineIndex += 1) {
        const oldText = lines[lineIndex] ?? "";
        const newText = nextLines[lineIndex] ?? "";
        const hasOld = lineIndex < lines.length;
        const hasNew = lineIndex < nextLines.length;
        rows.push(createContentRow(
          hasOld ? "remove" : "empty",
          hasNew ? "add" : "empty",
          hasOld ? oldLine + lineIndex : null,
          hasNew ? newLine + lineIndex : null,
          oldText,
          newText,
        ));
      }

      oldLine += lines.length;
      if (next?.added) {
        newLine += nextLines.length;
        index += 1;
      }
      continue;
    }

    if (change.added) {
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        rows.push(createContentRow("empty", "add", null, newLine, "", lines[lineIndex] ?? ""));
        newLine += 1;
      }
      continue;
    }

    for (const text of lines) {
      rows.push(createContentRow("context", "context", oldLine, newLine, text, text));
      oldLine += 1;
      newLine += 1;
    }
  }

  return rows;
}

function collapseSplitRows(rows: SplitDiffRow[]): SplitDiffRow[] {
  if (rows.length === 0) return rows;
  const collapsed: SplitDiffRow[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];
    const isContext = row.kind === "content" && row.oldKind === "context" && row.newKind === "context";
    if (!isContext) {
      collapsed.push(row);
      index += 1;
      continue;
    }

    let end = index;
    while (end < rows.length) {
      const candidate = rows[end];
      const candidateIsContext = candidate.kind === "content" && candidate.oldKind === "context" && candidate.newKind === "context";
      if (!candidateIsContext) {
        break;
      }
      end += 1;
    }

    const block = rows.slice(index, end);
    if (block.length <= CONTEXT_RADIUS * 2 + 1) {
      collapsed.push(...block);
    } else {
      collapsed.push(...block.slice(0, CONTEXT_RADIUS));
      collapsed.push({
        kind: "skip",
        oldKind: "empty",
        newKind: "empty",
        oldLine: null,
        newLine: null,
        oldText: "",
        newText: "",
        message: `${block.length - CONTEXT_RADIUS * 2} unchanged lines hidden`,
      });
      collapsed.push(...block.slice(-CONTEXT_RADIUS));
    }

    index = end;
  }

  return collapsed;
}

function toInlineRows(rows: SplitDiffRow[]): InlineDiffRow[] {
  const inlineRows: InlineDiffRow[] = [];

  for (const row of rows) {
    if (row.kind === "skip") {
      inlineRows.push({
        kind: "skip",
        lineKind: "context",
        oldLine: null,
        newLine: null,
        text: "",
        message: row.message,
      });
      continue;
    }

    if (row.oldKind === "context" && row.newKind === "context") {
      inlineRows.push({
        kind: "content",
        lineKind: "context",
        oldLine: row.oldLine,
        newLine: row.newLine,
        text: row.oldText,
      });
      continue;
    }

    if (row.oldKind === "remove") {
      inlineRows.push({
        kind: "content",
        lineKind: "remove",
        oldLine: row.oldLine,
        newLine: null,
        text: row.oldText,
      });
    }

    if (row.newKind === "add") {
      inlineRows.push({
        kind: "content",
        lineKind: "add",
        oldLine: null,
        newLine: row.newLine,
        text: row.newText,
      });
    }
  }

  return inlineRows;
}

function sideClasses(kind: DiffSideKind): string {
  if (kind === "add") {
    return "bg-[rgba(84,176,79,0.12)] text-[var(--vk-green)]";
  }
  if (kind === "remove") {
    return "bg-[rgba(210,81,81,0.12)] text-[var(--vk-red)]";
  }
  if (kind === "context") {
    return "text-[var(--vk-text-normal)]";
  }
  return "text-[var(--vk-text-muted)]";
}

function inlineRowClasses(kind: InlineDiffRow["lineKind"]): string {
  if (kind === "add") {
    return "bg-[rgba(84,176,79,0.12)] text-[var(--vk-green)]";
  }
  if (kind === "remove") {
    return "bg-[rgba(210,81,81,0.12)] text-[var(--vk-red)]";
  }
  return "text-[var(--vk-text-normal)]";
}

function markerForInlineRow(kind: InlineDiffRow["lineKind"]): string {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  return " ";
}

function SplitDiffView({ rows }: { rows: SplitDiffRow[] }) {
  return (
    <div className="min-w-[480px] sm:min-w-[720px] overflow-hidden rounded-[12px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.12)]">
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)] sm:grid-cols-[4rem_minmax(0,1fr)_4rem_minmax(0,1fr)] border-b border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
        <div className="border-r border-[var(--vk-border)] px-2 py-2">Old</div>
        <div className="border-r border-[var(--vk-border)] px-3 py-2">Before</div>
        <div className="border-r border-[var(--vk-border)] px-2 py-2">New</div>
        <div className="px-3 py-2">After</div>
      </div>
      <div className="font-mono text-[11px] sm:text-[12px] leading-6">
        {rows.map((row, index) => {
          if (row.kind === "skip") {
            return (
              <div
                key={`skip-${index}`}
                className="border-b border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-3 py-2 text-center text-[11px] text-[var(--vk-text-muted)] last:border-b-0"
              >
                {row.message}
              </div>
            );
          }

          return (
            <div
              key={`${row.oldLine ?? "x"}:${row.newLine ?? "y"}:${index}`}
              className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)] sm:grid-cols-[4rem_minmax(0,1fr)_4rem_minmax(0,1fr)] border-b border-[var(--vk-border)] last:border-b-0"
            >
              <div className={cn("border-r border-[var(--vk-border)] px-2 py-1 text-right text-[11px] text-[var(--vk-text-muted)]", sideClasses(row.oldKind))}>
                {row.oldLine ?? ""}
              </div>
              <div className={cn("border-r border-[var(--vk-border)] px-3 py-1 whitespace-pre overflow-x-auto", sideClasses(row.oldKind))}>
                {row.oldText || " "}
              </div>
              <div className={cn("border-r border-[var(--vk-border)] px-2 py-1 text-right text-[11px] text-[var(--vk-text-muted)]", sideClasses(row.newKind))}>
                {row.newLine ?? ""}
              </div>
              <div className={cn("px-3 py-1 whitespace-pre overflow-x-auto", sideClasses(row.newKind))}>
                {row.newText || " "}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InlineDiffView({ rows }: { rows: InlineDiffRow[] }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.12)]">
      <div className="grid grid-cols-[2rem_2rem_1rem_minmax(0,1fr)] sm:grid-cols-[4rem_4rem_1.5rem_minmax(0,1fr)] border-b border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
        <div className="border-r border-[var(--vk-border)] px-2 py-2">Old</div>
        <div className="border-r border-[var(--vk-border)] px-2 py-2">New</div>
        <div className="border-r border-[var(--vk-border)] px-2 py-2">Op</div>
        <div className="px-3 py-2">Content</div>
      </div>
      <div className="font-mono text-[11px] sm:text-[12px] leading-6">
        {rows.map((row, index) => {
          if (row.kind === "skip") {
            return (
              <div
                key={`skip-${index}`}
                className="border-b border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-3 py-2 text-center text-[11px] text-[var(--vk-text-muted)] last:border-b-0"
              >
                {row.message}
              </div>
            );
          }

          return (
            <div
              key={`${row.oldLine ?? "x"}:${row.newLine ?? "y"}:${index}`}
              className={cn(
                "grid grid-cols-[2rem_2rem_1rem_minmax(0,1fr)] sm:grid-cols-[4rem_4rem_1.5rem_minmax(0,1fr)] border-b border-[var(--vk-border)] last:border-b-0",
                inlineRowClasses(row.lineKind),
              )}
            >
              <div className="border-r border-[var(--vk-border)] px-2 py-1 text-right text-[11px] text-[var(--vk-text-muted)]">
                {row.oldLine ?? ""}
              </div>
              <div className="border-r border-[var(--vk-border)] px-2 py-1 text-right text-[11px] text-[var(--vk-text-muted)]">
                {row.newLine ?? ""}
              </div>
              <div className="border-r border-[var(--vk-border)] px-2 py-1 text-center">
                {markerForInlineRow(row.lineKind)}
              </div>
              <div className="px-3 py-1 whitespace-pre overflow-x-auto">
                {row.text || " "}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SessionDiff({ sessionId, active }: SessionDiffProps) {
  const encodedSessionId = encodeURIComponent(sessionId);
  const [payload, setPayload] = useState<ReviewDiffPayload>(EMPTY_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() => readStoredViewMode());
  const [hideUnchangedRegions, setHideUnchangedRegions] = useState(() => readStoredHideUnchanged());
  const [fileSearch, setFileSearch] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Record<DiffCategory, boolean>>({
    "against-base": false,
    staged: false,
    unstaged: false,
    untracked: true,
  });
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, FileContentsState>>({});

  const mountedRef = useRef(true);
  const payloadSignatureRef = useRef<string>("");
  const snapshotSignatureRef = useRef<string | null>(null);
  const terminalRef = useRef(false);
  const deferredFileSearch = useDeferredValue(fileSearch.trim().toLowerCase());

  const fetchDiff = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodedSessionId}/diff`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) {
          if (!mountedRef.current) return;
          setPayload(EMPTY_PAYLOAD);
          setError(null);
          setFileContents({});
          return;
        }

        let message = `Failed to fetch diff (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            message = data.error;
          }
        } catch {
          // Keep fallback message.
        }
        throw new Error(message);
      }

      const data = (await res.json()) as Partial<ReviewDiffPayload> & { error?: string };
      if (!mountedRef.current) return;
      if (data.error) throw new Error(data.error);

      const nextPayload: ReviewDiffPayload = {
        hasDiff: Boolean(data.hasDiff),
        generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
        source: data.source === "working-tree" || data.source === "remote-pr" ? data.source : "not-found",
        truncated: Boolean(data.truncated),
        branch: typeof data.branch === "string" ? data.branch : "",
        defaultBranch: typeof data.defaultBranch === "string" ? data.defaultBranch : "",
        files: Array.isArray(data.files) ? data.files : [],
        untracked: Array.isArray(data.untracked) ? data.untracked.filter((item): item is string => typeof item === "string") : [],
        sections: data.sections,
      };
      const nextSignature = JSON.stringify({
        hasDiff: nextPayload.hasDiff,
        source: nextPayload.source,
        truncated: nextPayload.truncated,
        branch: nextPayload.branch,
        defaultBranch: nextPayload.defaultBranch,
        files: nextPayload.files,
        untracked: nextPayload.untracked,
        sections: nextPayload.sections,
      });

      setPayload(nextPayload);
      if (payloadSignatureRef.current !== nextSignature) {
        payloadSignatureRef.current = nextSignature;
        setFileContents({});
      }
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setPayload(EMPTY_PAYLOAD);
      setError(err instanceof Error ? err.message : "Failed to load diff");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [encodedSessionId]);

  const loadFileContents = useCallback(async (entry: FileEntry, baseBranch: string) => {
    const { category, file, fileKey } = entry;

    setFileContents((current) => {
      const existing = current[fileKey];
      if (existing?.loading || existing?.loaded) {
        return current;
      }
      return {
        ...current,
        [fileKey]: { loading: true, loaded: false, error: null, data: null },
      };
    });

    try {
      const params = new URLSearchParams({
        path: file.path,
        category,
        status: file.status,
      });
      if (file.oldPath) {
        params.set("oldPath", file.oldPath);
      }
      if (baseBranch) {
        params.set("baseBranch", baseBranch);
      }

      const res = await fetch(`/api/sessions/${encodedSessionId}/diff?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        let message = `Failed to load diff contents (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            message = data.error;
          }
        } catch {
          // Keep fallback message.
        }
        throw new Error(message);
      }

      const data = (await res.json()) as Partial<FileContentsPayload> & { error?: string };
      if (!mountedRef.current) return;
      if (data.error) throw new Error(data.error);

      setFileContents((current) => ({
        ...current,
        [fileKey]: {
          loading: false,
          loaded: true,
          error: null,
          data: {
            path: typeof data.path === "string" ? data.path : file.path,
            oldPath: typeof data.oldPath === "string" ? data.oldPath : null,
            status: coerceStatus(data.status),
            category: data.category === "staged" || data.category === "unstaged" || data.category === "untracked"
              ? data.category
              : "against-base",
            baseBranch: typeof data.baseBranch === "string" ? data.baseBranch : baseBranch,
            binary: Boolean(data.binary),
            truncated: Boolean(data.truncated),
            originalSize: Number.isFinite(data.originalSize) ? Math.max(0, Number(data.originalSize)) : 0,
            modifiedSize: Number.isFinite(data.modifiedSize) ? Math.max(0, Number(data.modifiedSize)) : 0,
            original: typeof data.original === "string" || data.original === null ? data.original : "",
            modified: typeof data.modified === "string" || data.modified === null ? data.modified : "",
          },
        },
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      setFileContents((current) => ({
        ...current,
        [fileKey]: {
          loading: false,
          loaded: true,
          error: err instanceof Error ? err.message : "Failed to load diff contents",
          data: null,
        },
      }));
    }
  }, [encodedSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    snapshotSignatureRef.current = null;
    terminalRef.current = false;
    if (!active) {
      return () => {
        mountedRef.current = false;
      };
    }
    void fetchDiff();

    const unsubscribe = subscribeToSnapshotEvents((event: SSESessionEvent) => {
      if (!mountedRef.current) return;
      const matchingSession = event.sessions.find((value) => value.id === sessionId);
      if (!matchingSession) return;
      terminalRef.current = TERMINAL_STATUSES.has(matchingSession.status);
      const signature = `${matchingSession.status}:${matchingSession.lastActivityAt}`;
      if (snapshotSignatureRef.current === signature) {
        return;
      }
      snapshotSignatureRef.current = signature;
      void fetchDiff();
    });

    let timeoutId: number | null = null;
    const scheduleRefresh = () => {
      const delay = document.visibilityState === "visible" && !terminalRef.current
        ? ACTIVE_DIFF_REFRESH_MS
        : HIDDEN_DIFF_REFRESH_MS;
      timeoutId = window.setTimeout(async () => {
        if (!mountedRef.current) return;
        await fetchDiff();
        if (mountedRef.current) {
          scheduleRefresh();
        }
      }, delay);
    };
    scheduleRefresh();

    const refresh = () => {
      snapshotSignatureRef.current = null;
      void fetchDiff();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active, fetchDiff, sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEYS.viewMode, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEYS.hideUnchanged, hideUnchangedRegions ? "true" : "false");
  }, [hideUnchangedRegions]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    payloadSignatureRef.current = "";
    setFileSearch("");
    setSelectedFileKey(null);
    setFileContents({});
    setCollapsedSections({
      "against-base": false,
      staged: false,
      unstaged: false,
      untracked: true,
    });
  }, [sessionId]);

  const sections = useMemo(() => normalizeSections(payload), [payload]);
  const filteredSections = useMemo(() => {
    if (!deferredFileSearch) {
      return sections;
    }

    const filterFiles = (files: ChangedFileSummary[]) =>
      files.filter((file) => {
        const oldPath = file.oldPath ?? "";
        return file.path.toLowerCase().includes(deferredFileSearch) || oldPath.toLowerCase().includes(deferredFileSearch);
      });

    return {
      againstBase: filterFiles(sections.againstBase),
      staged: filterFiles(sections.staged),
      unstaged: filterFiles(sections.unstaged),
      untracked: filterFiles(sections.untracked),
    };
  }, [deferredFileSearch, sections]);

  const totals = useMemo(() => {
    const fileMap = new Map<string, ChangedFileSummary>();
    for (const category of SECTION_ORDER) {
      for (const file of getSectionFiles(sections, category)) {
        const key = createFileKey(category, file);
        if (!fileMap.has(key)) {
          fileMap.set(key, file);
        }
      }
    }

    let additions = 0;
    let deletions = 0;
    for (const file of fileMap.values()) {
      additions += file.additions;
      deletions += file.deletions;
    }

    return {
      files: fileMap.size,
      additions,
      deletions,
    };
  }, [sections]);

  const visibleEntries = useMemo(() => {
    const entries: FileEntry[] = [];
    for (const category of SECTION_ORDER) {
      for (const file of getSectionFiles(filteredSections, category)) {
        entries.push({
          category,
          file,
          fileKey: createFileKey(category, file),
        });
      }
    }
    return entries;
  }, [filteredSections]);

  const allEntries = useMemo(() => {
    const entries = new Map<string, FileEntry>();
    for (const category of SECTION_ORDER) {
      for (const file of getSectionFiles(sections, category)) {
        const fileKey = createFileKey(category, file);
        entries.set(fileKey, { category, file, fileKey });
      }
    }
    return entries;
  }, [sections]);

  useEffect(() => {
    if (visibleEntries.length === 0) {
      setSelectedFileKey(null);
      return;
    }

    setSelectedFileKey((current) => (
      current && visibleEntries.some((entry) => entry.fileKey === current)
        ? current
        : visibleEntries[0]?.fileKey ?? null
    ));
  }, [visibleEntries]);

  const selectedEntry = selectedFileKey ? allEntries.get(selectedFileKey) ?? null : null;
  const selectedState = selectedEntry ? (fileContents[selectedEntry.fileKey] ?? EMPTY_FILE_STATE) : EMPTY_FILE_STATE;
  const hasVisibleChanges = visibleEntries.length > 0;
  const activeBaseBranch = payload.defaultBranch?.trim() || "main";

  useEffect(() => {
    if (!active || !selectedEntry) return;
    const state = fileContents[selectedEntry.fileKey];
    if (state?.loading || state?.loaded) return;
    void loadFileContents(selectedEntry, activeBaseBranch);
  }, [active, activeBaseBranch, fileContents, loadFileContents, selectedEntry]);

  const splitRows = useMemo(() => {
    const diffData = selectedState.data;
    if (!diffData || diffData.binary) return [];
    const original = diffData.original ?? "";
    const modified = diffData.modified ?? "";
    const rows = buildSplitDiffRows(original, modified);
    return hideUnchangedRegions ? collapseSplitRows(rows) : rows;
  }, [hideUnchangedRegions, selectedState.data]);

  const inlineRows = useMemo(() => toInlineRows(splitRows), [splitRows]);

  const handleToggleSection = useCallback((category: DiffCategory) => {
    setCollapsedSections((current) => ({
      ...current,
      [category]: !current[category],
    }));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]">
      <div className="flex min-h-[42px] shrink-0 items-center gap-2 border-b border-[var(--vk-border)] px-3">
        <GitCompare className="h-[15px] w-[15px] text-[var(--vk-text-muted)]" />
        <span className="truncate text-[13px] font-medium text-[var(--vk-text-strong)]">Review Diff</span>
        <Badge variant="outline">{sourceLabel(payload.source)}</Badge>
        {payload.branch ? <Badge variant="outline">{payload.branch}</Badge> : null}
        {payload.defaultBranch ? <Badge variant="outline">base {payload.defaultBranch}</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-[var(--vk-text-muted)] lg:inline">
            {formatGeneratedAt(payload.generatedAt)}
          </span>
          <button
            type="button"
            onClick={() => void fetchDiff()}
            disabled={loading}
            className="inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            aria-label="Refresh diff"
          >
            <RefreshCw className={cn("h-[14px] w-[14px]", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3 text-[12px] text-[var(--vk-text-muted)]">
          <span>{totals.files} files</span>
          <span className="font-mono text-[var(--vk-green)]">+{totals.additions}</span>
          <span className="font-mono text-[var(--vk-red)]">-{totals.deletions}</span>
          {payload.truncated ? <span className="text-[var(--status-attention)]">Summary truncated</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setViewMode("side-by-side")}
            className={cn(
              "rounded-[6px] px-2 py-1 text-[11px]",
              viewMode === "side-by-side"
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]",
            )}
          >
            Split
          </button>
          <button
            type="button"
            onClick={() => setViewMode("inline")}
            className={cn(
              "rounded-[6px] px-2 py-1 text-[11px]",
              viewMode === "inline"
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]",
            )}
          >
            Inline
          </button>
          <button
            type="button"
            onClick={() => setHideUnchangedRegions((current) => !current)}
            className={cn(
              "rounded-[6px] px-2 py-1 text-[11px]",
              hideUnchangedRegions
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]",
            )}
          >
            {hideUnchangedRegions ? "Show all" : (<><span className="hidden sm:inline">Hide unchanged</span><span className="sm:hidden">Hide</span></>)}
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b border-[var(--vk-border)] p-2">
        <label className="flex items-center gap-2 rounded-[8px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] px-2.5 py-2">
          <Search className="h-4 w-4 text-[var(--vk-text-muted)]" />
          <input
            type="text"
            value={fileSearch}
            onChange={(event) => setFileSearch(event.target.value)}
            placeholder="Search changed files..."
            className="w-full bg-transparent text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && !payload.hasDiff && !error ? (
          <div className="flex h-full items-center justify-center p-8 text-[13px] text-[var(--vk-text-muted)]">
            Loading session diff...
          </div>
        ) : null}

        {error ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-[var(--status-error)]">
            {error}
          </div>
        ) : null}

        {!loading && !error && !hasVisibleChanges ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <CircleAlert className="h-7 w-7 text-[var(--vk-text-muted)]" />
            <p className="text-[13px] text-[var(--vk-text-muted)]">
              {deferredFileSearch ? "No files match the current search." : "No changed files in this session yet."}
            </p>
          </div>
        ) : null}

        {!error && hasVisibleChanges ? (
          <div className="grid h-full min-h-0 grid-rows-[minmax(10rem,14rem)_minmax(0,1fr)] sm:grid-rows-[minmax(14rem,18rem)_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1">
            <div className="min-h-0 overflow-y-auto border-b border-[var(--vk-border)] lg:border-b-0 lg:border-r">
              {SECTION_ORDER.map((category) => {
                const files = getSectionFiles(filteredSections, category);
                if (files.length === 0) {
                  return null;
                }

                const collapsed = collapsedSections[category];
                return (
                  <section key={category} className="border-b border-[var(--vk-border)] last:border-b-0">
                    <button
                      type="button"
                      onClick={() => handleToggleSection(category)}
                      className="sticky top-0 z-[5] flex w-full items-center gap-2 bg-[var(--vk-bg-panel)] px-3 py-2 text-left text-[12px] text-[var(--vk-text-muted)]"
                    >
                      {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      <span className="font-medium text-[var(--vk-text-normal)]">{SECTION_TITLES[category]}</span>
                      <span className="font-mono text-[var(--vk-text-muted)]">{files.length}</span>
                    </button>
                    {!collapsed ? (
                      <div className="py-1">
                        {files.map((file) => {
                          const fileKey = createFileKey(category, file);
                          const isSelected = fileKey === selectedFileKey;
                          return (
                            <button
                              key={fileKey}
                              type="button"
                              onClick={() => setSelectedFileKey(fileKey)}
                              className={cn(
                                "flex w-full items-start gap-2 border-l-2 px-3 py-2.5 text-left transition",
                                isSelected
                                  ? "border-l-[var(--status-working)] bg-[rgba(108,168,255,0.08)]"
                                  : "border-l-transparent hover:bg-[var(--vk-bg-hover)]",
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-[12px] text-[var(--vk-text-strong)]">
                                  {file.path}
                                </span>
                                <span className="mt-0.5 flex items-center gap-2">
                                  <span className={cn("inline-flex h-[20px] items-center rounded-[6px] border px-1.5 text-[10px]", statusPillClass(file))}>
                                    {statusLabel(file)}
                                  </span>
                                  {file.oldPath ? (
                                    <span className="truncate font-mono text-[10px] text-[var(--vk-text-muted)]">
                                      {file.oldPath}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-[var(--vk-text-muted)]">{SECTION_TITLES[category]}</span>
                                  )}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-[11px]">
                                {file.additions > 0 ? <span className="block text-right text-[var(--vk-green)]">+{file.additions}</span> : null}
                                {file.deletions > 0 ? <span className="block text-right text-[var(--vk-red)]">-{file.deletions}</span> : null}
                                {file.additions === 0 && file.deletions === 0 ? (
                                  <span className="block text-right text-[var(--vk-text-muted)]">0</span>
                                ) : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>

            <div className="min-h-0 overflow-y-auto overscroll-contain">
              {!selectedEntry ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  <FileCode2 className="h-8 w-8 text-[var(--vk-text-muted)]" />
                  <p className="text-[13px] text-[var(--vk-text-muted)]">Select a file to inspect its diff.</p>
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="border-b border-[var(--vk-border)] px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("inline-flex h-[24px] items-center rounded-[6px] border px-2 text-[11px]", statusPillClass(selectedEntry.file))}>
                        {statusLabel(selectedEntry.file)}
                      </span>
                      <span className="truncate font-mono text-[13px] text-[var(--vk-text-strong)]">
                        {selectedEntry.file.path}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--vk-text-muted)]">
                      <span>{SECTION_TITLES[selectedEntry.category]}</span>
                      {selectedEntry.file.oldPath ? <span className="font-mono">{selectedEntry.file.oldPath} -&gt; {selectedEntry.file.path}</span> : null}
                      <span className="font-mono text-[var(--vk-green)]">+{selectedEntry.file.additions}</span>
                      <span className="font-mono text-[var(--vk-red)]">-{selectedEntry.file.deletions}</span>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
                    {selectedState.loading ? (
                      <div className="flex h-full min-h-[240px] items-center justify-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                        <span>Loading diff...</span>
                      </div>
                    ) : null}

                    {selectedState.error ? (
                      <div className="flex min-h-[180px] items-center justify-center px-4 py-8 text-center text-[13px] text-[var(--status-error)]">
                        {selectedState.error}
                      </div>
                    ) : null}

                    {!selectedState.loading && !selectedState.error && selectedState.data?.binary ? (
                      <div className="flex min-h-[180px] items-center justify-center px-4 py-8 text-center text-[12px] text-[var(--vk-text-muted)]">
                        Binary file preview is not available for {getDisplaySessionId(sessionId).slice(0, 6)}.
                      </div>
                    ) : null}

                    {!selectedState.loading && !selectedState.error && selectedState.data && !selectedState.data.binary ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--vk-text-muted)]">
                          <span>Base: {selectedState.data.baseBranch || activeBaseBranch}</span>
                          <span>Original: {formatSize(selectedState.data.originalSize)}</span>
                          <span>Modified: {formatSize(selectedState.data.modifiedSize)}</span>
                          {selectedState.data.truncated ? (
                            <span className="text-[var(--status-attention)]">Preview truncated to 1 MB.</span>
                          ) : null}
                        </div>
                        <div className="overflow-auto pb-4">
                          {viewMode === "side-by-side" ? (
                            <SplitDiffView rows={splitRows} />
                          ) : (
                            <InlineDiffView rows={inlineRows} />
                          )}
                        </div>
                      </div>
                    ) : null}

                    {!selectedState.loading && !selectedState.error && !selectedState.data ? (
                      <div className="flex min-h-[180px] items-center justify-center px-4 py-8 text-center text-[12px] text-[var(--vk-text-muted)]">
                        No diff content available for this file.
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
