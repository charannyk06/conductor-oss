"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  GitCompare,
  Minus,
  Plus,
  RefreshCw,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";

type ReviewDiffKind = "meta" | "hunk" | "context" | "add" | "remove" | "info";
type ReviewDiffSource = "working-tree" | "remote-pr" | "not-found";
type ReviewDiffStatus = "modified" | "added" | "deleted" | "renamed" | "copy" | "binary" | "unknown";

interface ReviewDiffLine {
  kind: ReviewDiffKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface ReviewDiffFile {
  path: string;
  status: ReviewDiffStatus;
  additions: number;
  deletions: number;
  lines: ReviewDiffLine[];
  untracked?: boolean;
}

interface ReviewDiffPayload {
  hasDiff: boolean;
  generatedAt: string;
  source: ReviewDiffSource;
  truncated: boolean;
  files: ReviewDiffFile[];
  untracked: string[];
}

interface WorkspaceFilesPayload {
  workspacePath: string;
  files: string[];
  truncated: boolean;
}

interface WorkspaceFileContentPayload {
  workspacePath: string;
  path: string;
  content: string | null;
  size: number;
  binary: boolean;
  truncated: boolean;
}

interface FileTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  additions: number;
  deletions: number;
  status: ReviewDiffStatus;
  untracked: boolean;
}

interface FileTreeDirNode {
  kind: "dir";
  name: string;
  path: string;
  additions: number;
  deletions: number;
  fileCount: number;
  children: FileTreeNode[];
}

type FileTreeNode = FileTreeFileNode | FileTreeDirNode;

interface MutableDirNode {
  name: string;
  path: string;
  dirs: Map<string, MutableDirNode>;
  files: FileTreeFileNode[];
}

interface SessionDiffProps {
  sessionId: string;
}

const EMPTY_PAYLOAD: ReviewDiffPayload = {
  hasDiff: false,
  generatedAt: "",
  source: "not-found",
  truncated: false,
  files: [],
  untracked: [],
};

function coerceStatus(value: unknown): ReviewDiffStatus {
  if (
    value === "modified" ||
    value === "added" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "copy" ||
    value === "binary"
  ) {
    return value;
  }
  return "unknown";
}

function coerceKind(value: unknown): ReviewDiffKind {
  if (
    value === "meta" ||
    value === "hunk" ||
    value === "context" ||
    value === "add" ||
    value === "remove" ||
    value === "info"
  ) {
    return value;
  }
  return "context";
}

function normalizePath(path: unknown): string {
  if (typeof path !== "string") return "";
  const compact = path.trim().replace(/^\/+/, "").replace(/\/+/g, "/");
  return compact || "unknown-file";
}

function normalizeDiffFiles(payload: ReviewDiffPayload): ReviewDiffFile[] {
  const fileMap = new Map<string, ReviewDiffFile>();

  for (const raw of payload.files ?? []) {
    const path = normalizePath(raw.path);
    const normalized: ReviewDiffFile = {
      path,
      status: coerceStatus(raw.status),
      additions: Number.isFinite(raw.additions) ? Math.max(0, raw.additions) : 0,
      deletions: Number.isFinite(raw.deletions) ? Math.max(0, raw.deletions) : 0,
      lines: Array.isArray(raw.lines)
        ? raw.lines.map((line) => ({
            kind: coerceKind(line.kind),
            oldLine: typeof line.oldLine === "number" && Number.isFinite(line.oldLine) ? line.oldLine : null,
            newLine: typeof line.newLine === "number" && Number.isFinite(line.newLine) ? line.newLine : null,
            text: typeof line.text === "string" ? line.text : "",
          }))
        : [],
      untracked: Boolean(raw.untracked),
    };
    fileMap.set(path, normalized);
  }

  for (const path of payload.untracked ?? []) {
    const normalizedPath = normalizePath(path);
    if (fileMap.has(normalizedPath)) continue;
    fileMap.set(normalizedPath, {
      path: normalizedPath,
      status: "added",
      additions: 0,
      deletions: 0,
      lines: [],
      untracked: true,
    });
  }

  return [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

function createMutableDir(name: string, path: string): MutableDirNode {
  return {
    name,
    path,
    dirs: new Map<string, MutableDirNode>(),
    files: [],
  };
}

function toTreeNode(node: MutableDirNode): FileTreeDirNode {
  const dirChildren = [...node.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map(toTreeNode);

  const fileChildren = [...node.files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const children: FileTreeNode[] = [...dirChildren, ...fileChildren];
  let additions = 0;
  let deletions = 0;
  let fileCount = 0;

  for (const child of children) {
    if (child.kind === "dir") {
      additions += child.additions;
      deletions += child.deletions;
      fileCount += child.fileCount;
      continue;
    }
    additions += child.additions;
    deletions += child.deletions;
    fileCount += 1;
  }

  return {
    kind: "dir",
    name: node.name,
    path: node.path,
    additions,
    deletions,
    fileCount,
    children,
  };
}

function buildFileTree(files: ReviewDiffFile[]): FileTreeDirNode {
  const root = createMutableDir("", "");

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    const fileName = segments.pop() ?? file.path;
    let cursor = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = cursor.dirs.get(segment);
      if (existing) {
        cursor = existing;
        continue;
      }
      const next = createMutableDir(segment, currentPath);
      cursor.dirs.set(segment, next);
      cursor = next;
    }

    cursor.files.push({
      kind: "file",
      name: fileName,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
      untracked: Boolean(file.untracked),
    });
  }

  return toTreeNode(root);
}

function statusLabel(file: ReviewDiffFile): string {
  if (file.untracked) return "Untracked";
  if (file.status === "added") return "Added";
  if (file.status === "deleted") return "Deleted";
  if (file.status === "renamed") return "Renamed";
  if (file.status === "copy") return "Copied";
  if (file.status === "binary") return "Binary";
  if (file.status === "modified") return "Modified";
  return "Changed";
}

function sourceLabel(source: ReviewDiffSource): string {
  if (source === "working-tree") return "Working Tree";
  if (source === "remote-pr") return "Remote PR";
  return "Not Found";
}

function markerForLine(kind: ReviewDiffKind): string {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  if (kind === "hunk") return "@";
  if (kind === "info") return "i";
  return "";
}

function lineTone(kind: ReviewDiffKind): string {
  if (kind === "add") return "bg-[rgba(84,176,79,0.18)]";
  if (kind === "remove") return "bg-[rgba(210,81,81,0.18)]";
  if (kind === "hunk") return "bg-[rgba(108,168,255,0.12)]";
  return "";
}

function lineTextTone(kind: ReviewDiffKind): string {
  if (kind === "add") return "text-[var(--vk-green)]";
  if (kind === "remove") return "text-[var(--vk-red)]";
  if (kind === "hunk") return "text-[var(--status-working)]";
  if (kind === "meta" || kind === "info") return "text-[var(--vk-text-muted)]";
  return "text-[var(--vk-text-normal)]";
}

function statusPillClass(file: ReviewDiffFile): string {
  if (file.untracked || file.status === "added") {
    return "border-[rgba(84,176,79,0.35)] text-[var(--vk-green)]";
  }
  if (file.status === "deleted") {
    return "border-[rgba(210,81,81,0.35)] text-[var(--vk-red)]";
  }
  if (file.status === "renamed" || file.status === "copy") {
    return "border-[rgba(108,168,255,0.35)] text-[var(--status-working)]";
  }
  if (file.status === "binary") {
    return "border-[rgba(210,160,59,0.35)] text-[var(--status-attention)]";
  }
  return "border-[var(--vk-border)] text-[var(--vk-text-muted)]";
}

function formatGeneratedAt(value: string): string {
  if (!value) return "Not generated";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not generated";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SessionDiff({ sessionId }: SessionDiffProps) {
  const encodedSessionId = encodeURIComponent(sessionId);
  const [payload, setPayload] = useState<ReviewDiffPayload>(EMPTY_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<"changes" | "files">("changes");

  const [fileSearch, setFileSearch] = useState("");
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [wrapLines, setWrapLines] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);

  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});

  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [workspaceFilesLoaded, setWorkspaceFilesLoaded] = useState(false);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  const [workspaceFilesTruncated, setWorkspaceFilesTruncated] = useState(false);

  const [workspaceFileContent, setWorkspaceFileContent] = useState<string>("");
  const [workspaceFileBinary, setWorkspaceFileBinary] = useState(false);
  const [workspaceFileTruncated, setWorkspaceFileTruncated] = useState(false);
  const [workspaceFileSize, setWorkspaceFileSize] = useState(0);
  const [workspaceFileLoading, setWorkspaceFileLoading] = useState(false);
  const [workspaceFileError, setWorkspaceFileError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const parsedFiles = useCallback((data: ReviewDiffPayload) => normalizeDiffFiles(data), []);

  const fetchDiff = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodedSessionId}/diff`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) {
          if (!mountedRef.current) return;
          setPayload(EMPTY_PAYLOAD);
          setError(null);
          return;
        }

        let message = `Failed to fetch diff (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            message = data.error;
          }
        } catch {
          // keep fallback message
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
        files: Array.isArray(data.files)
          ? data.files.map((file) => ({
              path: normalizePath(file.path),
              status: coerceStatus(file.status),
              additions: Number.isFinite(file.additions) ? Math.max(0, Number(file.additions)) : 0,
              deletions: Number.isFinite(file.deletions) ? Math.max(0, Number(file.deletions)) : 0,
              lines: Array.isArray(file.lines)
                ? file.lines.map((line) => ({
                    kind: coerceKind(line.kind),
                    oldLine: typeof line.oldLine === "number" && Number.isFinite(line.oldLine) ? line.oldLine : null,
                    newLine: typeof line.newLine === "number" && Number.isFinite(line.newLine) ? line.newLine : null,
                    text: typeof line.text === "string" ? line.text : "",
                  }))
                : [],
            }))
          : [],
        untracked: Array.isArray(data.untracked)
          ? data.untracked.filter((path): path is string => typeof path === "string")
          : [],
      };

      const nextFiles = parsedFiles(nextPayload);
      setPayload(nextPayload);
      setSelectedPath((current) =>
        current && nextFiles.some((file) => file.path === current)
          ? current
          : (nextFiles[0]?.path ?? null),
      );
      setExpandedFiles((current) => {
        const next = { ...current };
        for (const file of nextFiles.slice(0, 10)) {
          if (next[file.path] == null) {
            next[file.path] = true;
          }
        }
        return next;
      });
      setError(null);
    } catch (err) {
      if (mountedRef.current) {
        setPayload(EMPTY_PAYLOAD);
        setError(err instanceof Error ? err.message : "Failed to load diff");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [encodedSessionId, parsedFiles]);

  const fetchWorkspaceFiles = useCallback(async () => {
    setWorkspaceFilesLoading(true);
    try {
      const res = await fetch(`/api/sessions/${encodedSessionId}/files`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) {
          if (!mountedRef.current) return;
          setWorkspaceFiles([]);
          setWorkspaceFilesLoaded(true);
          setWorkspaceFilesTruncated(false);
          setWorkspaceFilesError(null);
          return;
        }

        let message = `Failed to load workspace files (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            message = data.error;
          }
        } catch {
          // keep fallback
        }
        throw new Error(message);
      }

      const data = (await res.json()) as Partial<WorkspaceFilesPayload>;
      if (!mountedRef.current) return;

      const files = Array.isArray(data.files)
        ? data.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0)
        : [];
      setWorkspaceFiles(files);
      setWorkspaceFilesLoaded(true);
      setWorkspaceFilesTruncated(Boolean(data.truncated));
      setWorkspaceFilesError(null);
      setSelectedWorkspacePath((current) => (current && files.includes(current) ? current : (files[0] ?? null)));
    } catch (err) {
      if (!mountedRef.current) return;
      setWorkspaceFiles([]);
      setWorkspaceFilesLoaded(false);
      setWorkspaceFilesError(err instanceof Error ? err.message : "Failed to load workspace files");
    } finally {
      if (mountedRef.current) setWorkspaceFilesLoading(false);
    }
  }, [encodedSessionId]);

  const fetchWorkspaceFileContent = useCallback(async (path: string) => {
    setWorkspaceFileLoading(true);
    try {
      const query = encodeURIComponent(path);
      const res = await fetch(`/api/sessions/${encodedSessionId}/files?path=${query}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) {
          if (!mountedRef.current) return;
          setWorkspaceFileContent("");
          setWorkspaceFileBinary(false);
          setWorkspaceFileTruncated(false);
          setWorkspaceFileSize(0);
          setWorkspaceFileError("File no longer exists in this workspace.");
          return;
        }

        let message = `Failed to load file content (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            message = data.error;
          }
        } catch {
          // keep fallback
        }
        throw new Error(message);
      }

      const data = (await res.json()) as Partial<WorkspaceFileContentPayload>;
      if (!mountedRef.current) return;

      setWorkspaceFileContent(typeof data.content === "string" ? data.content : "");
      setWorkspaceFileBinary(Boolean(data.binary));
      setWorkspaceFileTruncated(Boolean(data.truncated));
      setWorkspaceFileSize(typeof data.size === "number" && Number.isFinite(data.size) ? Math.max(0, data.size) : 0);
      setWorkspaceFileError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setWorkspaceFileContent("");
      setWorkspaceFileBinary(false);
      setWorkspaceFileTruncated(false);
      setWorkspaceFileSize(0);
      setWorkspaceFileError(err instanceof Error ? err.message : "Failed to load file content");
    } finally {
      if (mountedRef.current) setWorkspaceFileLoading(false);
    }
  }, [encodedSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchDiff();
    const intervalId = window.setInterval(() => {
      if (mountedRef.current) void fetchDiff();
    }, 6000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(intervalId);
    };
  }, [fetchDiff]);

  useEffect(() => {
    setSidebarView("changes");
    setWorkspaceSearch("");
    setSelectedWorkspacePath(null);
    setWorkspaceFiles([]);
    setWorkspaceFilesLoaded(false);
    setWorkspaceFilesLoading(false);
    setWorkspaceFilesError(null);
    setWorkspaceFilesTruncated(false);
    setWorkspaceFileContent("");
    setWorkspaceFileBinary(false);
    setWorkspaceFileTruncated(false);
    setWorkspaceFileSize(0);
    setWorkspaceFileLoading(false);
    setWorkspaceFileError(null);
  }, [sessionId]);

  useEffect(() => {
    if (sidebarView !== "files") return;
    if (workspaceFilesLoaded || workspaceFilesLoading) return;
    void fetchWorkspaceFiles();
  }, [fetchWorkspaceFiles, sidebarView, workspaceFilesLoaded, workspaceFilesLoading]);

  useEffect(() => {
    if (sidebarView !== "files") return;
    if (!selectedWorkspacePath) return;
    void fetchWorkspaceFileContent(selectedWorkspacePath);
  }, [fetchWorkspaceFileContent, selectedWorkspacePath, sidebarView]);

  const allFiles = normalizeDiffFiles(payload);
  const fileSearchValue = fileSearch.trim().toLowerCase();
  const filteredFiles = fileSearchValue.length === 0
    ? allFiles
    : allFiles.filter((file) => file.path.toLowerCase().includes(fileSearchValue));
  const tree = buildFileTree(filteredFiles);
  const totalAdds = allFiles.reduce((sum, file) => sum + Math.max(0, file.additions), 0);
  const totalDeletes = allFiles.reduce((sum, file) => sum + Math.max(0, file.deletions), 0);
  const selectedFile = selectedPath
    ? allFiles.find((file) => file.path === selectedPath) ?? null
    : (allFiles[0] ?? null);
  const workspaceSearchValue = workspaceSearch.trim().toLowerCase();
  const filteredWorkspaceFiles = workspaceSearchValue.length === 0
    ? workspaceFiles
    : workspaceFiles.filter((path) => path.toLowerCase().includes(workspaceSearchValue));

  function handleSelectFile(path: string) {
    setSelectedPath(path);
    setExpandedFiles((current) => ({ ...current, [path]: true }));
    window.requestAnimationFrame(() => {
      fileRefs.current[path]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function toggleFile(path: string) {
    setExpandedFiles((current) => {
      const currentlyExpanded = current[path] ?? true;
      return { ...current, [path]: !currentlyExpanded };
    });
  }

  function toggleDir(path: string) {
    setCollapsedDirs((current) => ({ ...current, [path]: !current[path] }));
  }

  function renderTree(nodes: FileTreeNode[], depth = 0): ReactNode[] {
    const rows: ReactNode[] = [];

    for (const node of nodes) {
      if (node.kind === "dir") {
        const collapsed = Boolean(collapsedDirs[node.path]);
        rows.push(
          <button
            key={`dir-${node.path}`}
            type="button"
            onClick={() => toggleDir(node.path)}
            className="flex h-[26px] w-full items-center gap-1.5 pr-2 text-left text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            )}
            {collapsed ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--vk-text-muted)]">
              {node.fileCount}
            </span>
          </button>,
        );

        if (!collapsed) {
          rows.push(...renderTree(node.children, depth + 1));
        }
        continue;
      }

      const active = node.path === selectedPath;
      rows.push(
        <button
          key={`file-${node.path}`}
          type="button"
          onClick={() => handleSelectFile(node.path)}
          className={`flex h-[26px] w-full items-center gap-1.5 pr-2 text-left text-[12px] transition-colors ${
            active
              ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
              : "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span className="inline-flex w-4 shrink-0 justify-center">
            {node.untracked ? (
              <FilePlus2 className="h-3.5 w-3.5 text-[var(--vk-green)]" />
            ) : (
              <FileCode2 className="h-3.5 w-3.5 text-[var(--vk-text-muted)]" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.additions > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-[var(--vk-green)]">+{node.additions}</span>
          )}
          {node.deletions > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-[var(--vk-red)]">-{node.deletions}</span>
          )}
        </button>,
      );
    }

    return rows;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]">
      <div className="flex h-[32px] shrink-0 items-center border-b border-[var(--vk-border)] px-2">
        <div className="flex min-w-0 items-center gap-2">
          <GitCompare className="h-[15px] w-[15px] text-[var(--vk-text-muted)]" />
          <span className="truncate text-[13px] font-medium text-[var(--vk-text-strong)]">Review Diff</span>
          <Badge variant="outline" className="h-[20px] px-1.5 text-[10px]">
            {sourceLabel(payload.source)}
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-[var(--vk-text-muted)] md:inline">
            {formatGeneratedAt(payload.generatedAt)}
          </span>
          <button
            type="button"
            onClick={() => void fetchDiff()}
            disabled={loading}
            className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            aria-label="Refresh diff"
          >
            <RefreshCw className={`h-[14px] w-[14px] ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setWrapLines((value) => !value)}
            className={`inline-flex h-[22px] items-center gap-1 rounded-[3px] px-1.5 text-[11px] ${
              wrapLines
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
            }`}
            aria-label="Toggle wrapped lines"
          >
            <WrapText className="h-[14px] w-[14px]" />
            Wrap
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-[var(--vk-border)] xl:border-b-0 xl:border-r">
          <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-[var(--vk-border)] px-2 text-[11px] text-[var(--vk-text-muted)]">
            <span>{allFiles.length} files changed</span>
            <span className="inline-flex items-center gap-0.5 text-[var(--vk-green)]">
              <Plus className="h-[12px] w-[12px]" />
              {totalAdds}
            </span>
            <span className="inline-flex items-center gap-0.5 text-[var(--vk-red)]">
              <Minus className="h-[12px] w-[12px]" />
              {totalDeletes}
            </span>
            {payload.truncated && (
              <span className="ml-auto text-[var(--status-attention)]">Output truncated</span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-[var(--vk-bg-panel)]">
            {loading && allFiles.length === 0 && !error && (
              <div className="flex h-full items-center justify-center p-8 text-[13px] text-[var(--vk-text-muted)]">
                Loading session diff...
              </div>
            )}

            {error && (
              <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-[var(--status-error)]">
                {error}
              </div>
            )}

            {!loading && !error && allFiles.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <CircleAlert className="h-7 w-7 text-[var(--vk-text-muted)]" />
                <p className="text-[13px] text-[var(--vk-text-muted)]">No changed files in this session yet.</p>
              </div>
            )}

            {!error &&
              allFiles.length > 0 &&
              allFiles.map((file) => {
                const expanded = expandedFiles[file.path] ?? true;
                const selected = selectedFile?.path === file.path;

                return (
                  <div
                    key={file.path}
                    ref={(node) => {
                      fileRefs.current[file.path] = node;
                    }}
                    className={`border-b border-[var(--vk-border)] ${selected ? "bg-[var(--vk-bg-active)]/40" : "bg-[var(--vk-bg-panel)]"}`}
                  >
                    <div className="flex min-h-[40px] items-center gap-2 px-2">
                      <button
                        type="button"
                        onClick={() => toggleFile(file.path)}
                        className="inline-flex h-[20px] w-[20px] items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                        aria-label={expanded ? `Collapse ${file.path}` : `Expand ${file.path}`}
                      >
                        {expanded ? (
                          <ChevronDown className="h-[15px] w-[15px]" />
                        ) : (
                          <ChevronRight className="h-[15px] w-[15px]" />
                        )}
                      </button>

                      <span
                        className={`inline-flex h-[23px] min-w-[58px] items-center justify-center rounded-[3px] border px-1.5 text-[11px] ${statusPillClass(file)}`}
                      >
                        {statusLabel(file)}
                      </span>

                      <button
                        type="button"
                        onClick={() => handleSelectFile(file.path)}
                        className={`min-w-0 flex-1 truncate text-left font-mono text-[12px] ${
                          selected ? "text-[var(--vk-text-strong)]" : "text-[var(--vk-text-normal)]"
                        }`}
                      >
                        {file.path}
                      </button>

                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        {file.additions > 0 && <span className="text-[var(--vk-green)]">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="text-[var(--vk-red)]">-{file.deletions}</span>}
                        {file.additions === 0 && file.deletions === 0 && (
                          <span className="text-[var(--vk-text-muted)]">0</span>
                        )}
                      </div>
                    </div>

                    {expanded && (
                      <div className="border-t border-[var(--vk-border)] bg-[var(--vk-bg-outer)]/30">
                        {file.lines.length === 0 ? (
                          <div className="px-2 py-2 font-mono text-[11px] text-[var(--vk-text-muted)]">
                            {file.untracked
                              ? "Untracked file (line-level diff unavailable until staged)."
                              : "No line-level diff output for this file."}
                          </div>
                        ) : (
                          <div className={wrapLines ? "" : "overflow-x-auto"}>
                            <div className={wrapLines ? "" : "min-w-[760px]"}>
                              <div className="grid grid-cols-[56px_56px_20px_minmax(0,1fr)] border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">
                                <div>Old</div>
                                <div>New</div>
                                <div />
                                <div>Line</div>
                              </div>

                              {file.lines.map((line, index) => (
                                <div
                                  key={`${file.path}-${index}-${line.oldLine ?? "x"}-${line.newLine ?? "y"}`}
                                  className={`grid grid-cols-[56px_56px_20px_minmax(0,1fr)] border-b border-[var(--vk-border)] px-2 py-[2px] font-mono text-[11px] last:border-b-0 ${lineTone(line.kind)}`}
                                >
                                  <div className="text-[var(--vk-text-muted)]">{line.oldLine ?? ""}</div>
                                  <div className="text-[var(--vk-text-muted)]">{line.newLine ?? ""}</div>
                                  <div className={lineTextTone(line.kind)}>{markerForLine(line.kind)}</div>
                                  <div className={`${lineTextTone(line.kind)} ${wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
                                    {line.text}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </section>

        <aside className="flex min-h-0 w-full shrink-0 flex-col bg-[var(--vk-bg-panel)] xl:w-[299px]">
          <div className="flex h-[32px] items-center gap-1 border-b border-[var(--vk-border)] p-1">
            <button
              type="button"
              onClick={() => setSidebarView("changes")}
              className={`inline-flex h-[24px] items-center rounded-[3px] px-2 text-[12px] ${
                sidebarView === "changes"
                  ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                  : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
              }`}
            >
              Changes
            </button>
            <button
              type="button"
              onClick={() => setSidebarView("files")}
              className={`inline-flex h-[24px] items-center rounded-[3px] px-2 text-[12px] ${
                sidebarView === "files"
                  ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                  : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
              }`}
            >
              Files
            </button>
          </div>

          {sidebarView === "changes" ? (
            <>
              <div className="border-b border-[var(--vk-border)] p-2">
                <div className="flex items-center gap-2 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-[5px]">
                  <Search className="h-[15px] w-[15px] text-[var(--vk-text-muted)]" />
                  <input
                    type="text"
                    value={fileSearch}
                    onChange={(event) => setFileSearch(event.target.value)}
                    placeholder="Search files..."
                    className="h-[20px] w-full bg-transparent text-[14px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                  />
                  {fileSearch.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setFileSearch("")}
                      className="inline-flex h-[17px] w-[17px] items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                      aria-label="Clear file search"
                    >
                      <X className="h-[12px] w-[12px]" />
                    </button>
                  )}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {filteredFiles.length === 0 ? (
                  <div className="px-3 py-3 text-[13px] text-[var(--vk-text-muted)]">
                    {fileSearchValue.length > 0 ? "No files match the current search." : "No changed files."}
                  </div>
                ) : (
                  <div className="py-1">{renderTree(tree.children)}</div>
                )}
              </div>

              <div className="border-t border-[var(--vk-border)] p-2">
                <div className="text-[16px] font-medium text-[var(--vk-text-normal)]">Git</div>
                <div className="mt-2 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2 py-2">
                  <div className="flex items-center justify-between text-[12px] text-[var(--vk-text-muted)]">
                    <span>Files</span>
                    <span className="font-mono text-[var(--vk-text-normal)]">{allFiles.length}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[12px]">
                    <span className="text-[var(--vk-text-muted)]">Added</span>
                    <span className="font-mono text-[var(--vk-green)]">+{totalAdds}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[12px]">
                    <span className="text-[var(--vk-text-muted)]">Deleted</span>
                    <span className="font-mono text-[var(--vk-red)]">-{totalDeletes}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[12px]">
                    <span className="text-[var(--vk-text-muted)]">Source</span>
                    <span className="font-mono text-[var(--vk-text-normal)]">{sourceLabel(payload.source)}</span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-[var(--vk-border)] p-2">
                <div className="flex items-center gap-2 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-[5px]">
                  <Search className="h-[15px] w-[15px] text-[var(--vk-text-muted)]" />
                  <input
                    type="text"
                    value={workspaceSearch}
                    onChange={(event) => setWorkspaceSearch(event.target.value)}
                    placeholder="Search all files..."
                    className="h-[20px] w-full bg-transparent text-[14px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                  />
                  {workspaceSearch.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setWorkspaceSearch("")}
                      className="inline-flex h-[17px] w-[17px] items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                      aria-label="Clear workspace file search"
                    >
                      <X className="h-[12px] w-[12px]" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 overflow-auto border-b border-[var(--vk-border)]">
                  {workspaceFilesLoading && (
                    <div className="px-3 py-3 text-[13px] text-[var(--vk-text-muted)]">
                      Loading workspace files...
                    </div>
                  )}

                  {workspaceFilesError && (
                    <div className="px-3 py-3 text-[13px] text-[var(--status-error)]">
                      {workspaceFilesError}
                    </div>
                  )}

                  {!workspaceFilesLoading && !workspaceFilesError && filteredWorkspaceFiles.length === 0 && (
                    <div className="px-3 py-3 text-[13px] text-[var(--vk-text-muted)]">
                      {workspaceSearchValue.length > 0 ? "No files match the current search." : "No files found."}
                    </div>
                  )}

                  {!workspaceFilesLoading && !workspaceFilesError && filteredWorkspaceFiles.length > 0 && (
                    <div className="py-1">
                      {filteredWorkspaceFiles.map((path) => {
                        const selected = path === selectedWorkspacePath;
                        const fileName = path.split("/").pop() ?? path;
                        return (
                          <button
                            key={path}
                            type="button"
                            onClick={() => setSelectedWorkspacePath(path)}
                            className={`flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-[12px] ${
                              selected
                                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                                : "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
                            <span className="truncate">{fileName}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-auto bg-[var(--vk-bg-main)] p-2">
                  <div className="flex items-center justify-between border-b border-[var(--vk-border)] pb-2">
                    <span className="truncate font-mono text-[11px] text-[var(--vk-text-normal)]">
                      {selectedWorkspacePath ?? "Select a file"}
                    </span>
                    {workspaceFileSize > 0 && (
                      <span className="ml-2 shrink-0 font-mono text-[10px] text-[var(--vk-text-muted)]">
                        {workspaceFileSize.toLocaleString()} bytes
                      </span>
                    )}
                  </div>

                  {workspaceFilesTruncated && (
                    <p className="pt-2 text-[11px] text-[var(--status-attention)]">
                      File list truncated to the first 4000 files.
                    </p>
                  )}

                  {workspaceFileLoading && (
                    <p className="pt-2 text-[12px] text-[var(--vk-text-muted)]">Loading file content...</p>
                  )}

                  {workspaceFileError && (
                    <p className="pt-2 text-[12px] text-[var(--status-error)]">{workspaceFileError}</p>
                  )}

                  {!workspaceFileLoading && !workspaceFileError && selectedWorkspacePath && workspaceFileBinary && (
                    <p className="pt-2 text-[12px] text-[var(--vk-text-muted)]">
                      Binary file preview is not available.
                    </p>
                  )}

                  {!workspaceFileLoading &&
                    !workspaceFileError &&
                    selectedWorkspacePath &&
                    !workspaceFileBinary &&
                    workspaceFileContent.length > 0 && (
                      <pre className="pt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--vk-text-normal)]">
                        {workspaceFileContent}
                      </pre>
                    )}

                  {!workspaceFileLoading &&
                    !workspaceFileError &&
                    selectedWorkspacePath &&
                    !workspaceFileBinary &&
                    workspaceFileContent.length === 0 && (
                      <p className="pt-2 text-[12px] text-[var(--vk-text-muted)]">File is empty.</p>
                    )}

                  {workspaceFileTruncated && (
                    <p className="pt-2 text-[11px] text-[var(--status-attention)]">
                      Preview truncated to 1 MB.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
