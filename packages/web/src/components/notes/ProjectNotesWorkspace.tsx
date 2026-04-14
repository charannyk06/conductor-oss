"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookText,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCcw,
  Save,
  Search,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import type { DashboardSession } from "@/lib/types";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { isProjectDispatcherSession } from "@/lib/sessionKinds";

interface ProjectNotesWorkspaceProps {
  projectId: string;
  bridgeId?: string | null;
  sessions: DashboardSession[];
  selectedSessionId?: string | null;
}

type ViewMode = "split" | "edit" | "preview";

type NoteFile = {
  path: string;
  displayPath: string;
  name: string;
  source: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  kind: string;
};

type NotesIndexPayload = {
  editor: string;
  notesRoot: string | null;
  syncManagedByEditor: boolean;
  writable: boolean;
  files: NoteFile[];
};

type NoteFilePayload = {
  path: string;
  displayPath: string;
  content: string;
  size: number;
  truncated: boolean;
  modifiedAt: string | null;
  writable: boolean;
};

type SaveNotePayload = {
  ok: boolean;
  path: string;
  displayPath: string;
  modifiedAt: string | null;
  savedBytes: number;
  created: boolean;
};

type NotesTreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  file?: NoteFile;
  children: NotesTreeNode[];
};

function buildNotesTree(files: NoteFile[]): NotesTreeNode[] {
  const root: NotesTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const file of files) {
    const normalizedDisplayPath = file.displayPath.replace(/^\/+/, "");
    const parts = normalizedDisplayPath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let current = root;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = index === parts.length - 1;
      let child = current.children.find((candidate) => candidate.name === part && candidate.isDirectory !== isLast);
      if (!child) {
        child = {
          name: part,
          path: isLast ? file.path : currentPath,
          isDirectory: !isLast,
          file: isLast ? file : undefined,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  const sortTree = (nodes: NotesTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortTree(node.children);
      }
    }
  };

  sortTree(root.children);
  return root.children;
}

function filterNotesTree(nodes: NotesTreeNode[], query: string): NotesTreeNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  const filterNode = (node: NotesTreeNode): NotesTreeNode | null => {
    const haystack = `${node.name} ${node.file?.displayPath ?? ""}`.toLowerCase();
    const childMatches = node.children
      .map((child) => filterNode(child))
      .filter((child): child is NotesTreeNode => Boolean(child));
    if (haystack.includes(normalizedQuery) || childMatches.length > 0) {
      return {
        ...node,
        children: childMatches,
      };
    }
    return null;
  };

  return nodes
    .map((node) => filterNode(node))
    .filter((node): node is NotesTreeNode => Boolean(node));
}

function collectFolderPaths(nodes: NotesTreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (node: NotesTreeNode) => {
    if (node.isDirectory) {
      paths.push(node.path);
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return paths;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) {
    return "";
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeNewNotePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  if (/\.(md|markdown|mdx|txt)$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}.md`;
}

function buildNewNoteSeedContent(notePath: string): string {
  const fileName = notePath.split("/").pop() ?? "Note";
  const heading = fileName.replace(/\.(md|markdown|mdx|txt)$/i, "").replace(/[-_]+/g, " ").trim();
  if (!heading) {
    return "";
  }
  return `# ${heading.charAt(0).toUpperCase()}${heading.slice(1)}\n\n`;
}

function NotesTree({
  nodes,
  expandedFolders,
  selectedPath,
  onToggleFolder,
  onSelectFile,
  depth = 0,
}: {
  nodes: NotesTreeNode[];
  expandedFolders: Set<string>;
  selectedPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        const paddingLeft = 10 + depth * 14;
        if (node.isDirectory) {
          const expanded = expandedFolders.has(node.path);
          return (
            <div key={`${node.path}-${node.name}`}>
              <button
                type="button"
                onClick={() => onToggleFolder(node.path)}
                className="flex w-full items-center gap-1.5 py-1.5 text-left text-[12px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                style={{ paddingLeft }}
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
                {expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--vk-accent)]" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--vk-accent)]" />
                )}
                <span className="truncate">{node.name}</span>
              </button>
              {expanded ? (
                <NotesTree
                  nodes={node.children}
                  expandedFolders={expandedFolders}
                  selectedPath={selectedPath}
                  onToggleFolder={onToggleFolder}
                  onSelectFile={onSelectFile}
                  depth={depth + 1}
                />
              ) : null}
            </div>
          );
        }

        const selected = selectedPath === node.path;
        return (
          <button
            key={node.path}
            type="button"
            onClick={() => onSelectFile(node.path)}
            className={`flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-[12px] ${
              selected
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            }`}
            style={{ paddingLeft: paddingLeft + 18 }}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            <span className="truncate">{node.name}</span>
          </button>
        );
      })}
    </>
  );
}

export function ProjectNotesWorkspace({
  projectId,
  bridgeId = null,
  sessions,
  selectedSessionId = null,
}: ProjectNotesWorkspaceProps) {
  const [indexPayload, setIndexPayload] = useState<NotesIndexPayload | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [draftContent, setDraftContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileModifiedAt, setFileModifiedAt] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [newNotePath, setNewNotePath] = useState("");
  const [creatingNote, setCreatingNote] = useState(false);
  const [composerMessage, setComposerMessage] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [sendingDispatcher, setSendingDispatcher] = useState(false);
  const [sendingSession, setSendingSession] = useState(false);
  const [targetSessionId, setTargetSessionId] = useState<string>(selectedSessionId ?? "");
  const latestLoadId = useRef(0);

  const noteFiles = indexPayload?.files ?? [];
  const selectedFile = useMemo(
    () => noteFiles.find((file) => file.path === selectedPath) ?? null,
    [noteFiles, selectedPath],
  );
  const dirty = draftContent !== savedContent;
  const supportedLocalNotes = indexPayload?.writable !== false;
  const sessionTargets = useMemo(
    () => sessions.filter((session) => !isProjectDispatcherSession(session)),
    [sessions],
  );

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    setTargetSessionId(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (sessionTargets.length === 0) {
      setTargetSessionId("");
      return;
    }
    if (!targetSessionId || !sessionTargets.some((session) => session.id === targetSessionId)) {
      setTargetSessionId(selectedSessionId && sessionTargets.some((session) => session.id === selectedSessionId)
        ? selectedSessionId
        : sessionTargets[0]?.id ?? "");
    }
  }, [selectedSessionId, sessionTargets, targetSessionId]);

  const refreshIndex = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIndexLoading(true);
    setIndexError(null);
    const loadIndex = async () => {
      try {
        const response = await fetch(
          withBridgeQuery(`/api/project-notes?projectId=${encodeURIComponent(projectId)}`, bridgeId),
          { cache: "no-store" },
        );
        const payload = (await response.json().catch(() => null)) as
          | NotesIndexPayload
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(payload && "error" in payload ? payload.error ?? "Failed to load notes" : `Failed to load notes (${response.status})`);
        }
        if (cancelled) return;
        setIndexPayload((payload as NotesIndexPayload) ?? null);
      } catch (error) {
        if (cancelled) return;
        setIndexPayload(null);
        setIndexError(error instanceof Error ? error.message : "Failed to load notes workspace");
      } finally {
        if (!cancelled) {
          setIndexLoading(false);
        }
      }
    };

    void loadIndex();
    return () => {
      cancelled = true;
    };
  }, [bridgeId, projectId, refreshNonce]);

  useEffect(() => {
    if (noteFiles.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !noteFiles.some((file) => file.path === selectedPath)) {
      setSelectedPath(noteFiles[0]?.path ?? null);
    }
  }, [noteFiles, selectedPath]);

  const filteredTree = useMemo(() => {
    const matchingFiles = search.trim().length === 0
      ? noteFiles
      : noteFiles.filter((file) => {
          const haystack = `${file.displayPath} ${file.name} ${file.source ?? ""}`.toLowerCase();
          return haystack.includes(search.trim().toLowerCase());
        });
    return filterNotesTree(buildNotesTree(matchingFiles), search);
  }, [noteFiles, search]);

  useEffect(() => {
    if (search.trim().length === 0) {
      return;
    }
    setExpandedFolders(collectFolderPaths(filteredTree));
  }, [filteredTree, search]);

  useEffect(() => {
    if (!selectedPath) {
      setDraftContent("");
      setSavedContent("");
      setFileModifiedAt(null);
      setFileError(null);
      return;
    }

    let cancelled = false;
    latestLoadId.current += 1;
    const loadId = latestLoadId.current;
    setFileLoading(true);
    setFileError(null);
    setSaveError(null);
    setSaveSuccess(null);

    const loadFile = async () => {
      try {
        const params = new URLSearchParams({
          projectId,
          path: selectedPath,
        });
        const response = await fetch(withBridgeQuery(`/api/project-notes/file?${params.toString()}`, bridgeId), {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | NoteFilePayload
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(payload && "error" in payload ? payload.error ?? "Failed to load note" : `Failed to load note (${response.status})`);
        }
        if (cancelled || latestLoadId.current !== loadId) return;
        const note = payload as NoteFilePayload;
        setDraftContent(note.content ?? "");
        setSavedContent(note.content ?? "");
        setFileModifiedAt(note.modifiedAt ?? null);
      } catch (error) {
        if (cancelled || latestLoadId.current !== loadId) return;
        setDraftContent("");
        setSavedContent("");
        setFileModifiedAt(null);
        setFileError(error instanceof Error ? error.message : "Failed to load note");
      } finally {
        if (!cancelled && latestLoadId.current === loadId) {
          setFileLoading(false);
        }
      }
    };

    void loadFile();
    return () => {
      cancelled = true;
    };
  }, [bridgeId, projectId, selectedPath]);

  const saveCurrentNote = useCallback(async () => {
    if (!selectedFile) {
      return null;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const response = await fetch(withBridgeQuery("/api/project-notes/file", bridgeId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          path: selectedFile.path,
          content: draftContent,
          expectedModifiedAt: fileModifiedAt,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | SaveNotePayload
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload ? payload.error ?? "Failed to save note" : `Failed to save note (${response.status})`);
      }
      const savePayload = payload as SaveNotePayload;
      setSavedContent(draftContent);
      setFileModifiedAt(savePayload.modifiedAt ?? null);
      setSaveSuccess(savePayload.created ? "Note created." : "Note saved.");
      refreshIndex();
      return savePayload;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save note");
      return null;
    } finally {
      setSaving(false);
    }
  }, [bridgeId, draftContent, fileModifiedAt, projectId, refreshIndex, selectedFile]);

  const handleOpenExternally = useCallback(async () => {
    if (!selectedFile) {
      return;
    }
    if (dirty) {
      const saved = await saveCurrentNote();
      if (!saved) {
        return;
      }
    }
    setOpening(true);
    setOpenError(null);
    try {
      const response = await fetch(withBridgeQuery("/api/project-notes/open", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          path: selectedFile.path,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to open note (${response.status})`);
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Failed to open note");
    } finally {
      setOpening(false);
    }
  }, [bridgeId, dirty, projectId, saveCurrentNote, selectedFile]);

  const handleCreateNote = useCallback(async () => {
    const normalizedPath = normalizeNewNotePath(newNotePath);
    if (!normalizedPath || creatingNote) {
      return;
    }
    setCreatingNote(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const response = await fetch(withBridgeQuery("/api/project-notes/file", bridgeId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          path: normalizedPath,
          content: buildNewNoteSeedContent(normalizedPath),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | SaveNotePayload
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload ? payload.error ?? "Failed to create note" : `Failed to create note (${response.status})`);
      }
      const created = payload as SaveNotePayload;
      setNewNotePath("");
      setSelectedPath(created.path);
      setSaveSuccess("Note created.");
      refreshIndex();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to create note");
    } finally {
      setCreatingNote(false);
    }
  }, [bridgeId, creatingNote, newNotePath, projectId, refreshIndex]);

  const sendToDispatcher = useCallback(async () => {
    if ((!selectedFile && composerMessage.trim().length === 0) || sendingDispatcher) {
      return;
    }
    if (dirty) {
      const saved = await saveCurrentNote();
      if (!saved) {
        return;
      }
    }
    setSendingDispatcher(true);
    setSendError(null);
    setSendSuccess(null);
    try {
      const response = await fetch(
        withBridgeQuery(`/api/projects/${encodeURIComponent(projectId)}/dispatcher/send`, bridgeId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: composerMessage.trim(),
            attachments: selectedFile ? [selectedFile.path] : [],
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to send note to dispatcher (${response.status})`);
      }
      setSendSuccess(selectedFile ? "Sent note to dispatcher." : "Sent message to dispatcher.");
      setComposerMessage("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send note to dispatcher");
    } finally {
      setSendingDispatcher(false);
    }
  }, [bridgeId, composerMessage, dirty, projectId, saveCurrentNote, selectedFile, sendingDispatcher]);

  const sendToSession = useCallback(async () => {
    if ((!selectedFile && composerMessage.trim().length === 0) || !targetSessionId || sendingSession) {
      return;
    }
    if (dirty) {
      const saved = await saveCurrentNote();
      if (!saved) {
        return;
      }
    }
    setSendingSession(true);
    setSendError(null);
    setSendSuccess(null);
    try {
      const response = await fetch(
        withBridgeQuery(`/api/sessions/${encodeURIComponent(targetSessionId)}/send`, bridgeId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: composerMessage.trim(),
            attachments: selectedFile ? [selectedFile.path] : [],
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to send note to session (${response.status})`);
      }
      const selectedSession = sessionTargets.find((session) => session.id === targetSessionId);
      setSendSuccess(selectedSession
        ? `Sent note to ${selectedSession.branch || selectedSession.id.slice(0, 8)}.`
        : "Sent note to session.");
      setComposerMessage("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send note to session");
    } finally {
      setSendingSession(false);
    }
  }, [bridgeId, composerMessage, dirty, saveCurrentNote, selectedFile, sendingSession, sessionTargets, targetSessionId]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((current) =>
      current.includes(path)
        ? current.filter((entry) => entry !== path)
        : [...current, path],
    );
  }, []);

  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const rootLabel = indexPayload?.notesRoot
    ? indexPayload.notesRoot
    : indexPayload?.editor?.trim().toLowerCase() === "notion"
      ? "Notion"
      : "Project markdown files";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
      <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                Notes Workspace
              </p>
              {indexPayload?.syncManagedByEditor ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(139,92,246,0.12)] px-2 py-0.5 text-[11px] text-[#cdb4ff]">
                  <Sparkles className="h-3 w-3" />
                  Synced by Obsidian
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[14px] text-[var(--vk-text-strong)]">
              {projectId} · {indexPayload?.editor || "markdown"}
            </p>
            <p className="mt-1 truncate text-[12px] text-[var(--vk-text-muted)]">
              {rootLabel}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-[6px] border border-[var(--vk-border)] p-0.5 text-[12px]">
              {(["split", "edit", "preview"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={`rounded-[4px] px-3 py-1.5 ${
                    viewMode === mode
                      ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                      : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                  }`}
                >
                  {mode === "split" ? "Split" : mode === "edit" ? "Edit" : "Preview"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={refreshIndex}
              disabled={indexLoading}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            >
              {indexLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void saveCurrentNote()}
              disabled={!selectedFile || !dirty || saving}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => void handleOpenExternally()}
              disabled={!selectedFile || opening}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            >
              {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
              Open in {indexPayload?.editor || "editor"}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search notes"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={newNotePath}
              onChange={(event) => setNewNotePath(event.target.value)}
              placeholder="New note path, example: architecture/overview.md"
              className="min-h-[34px] min-w-0 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)] sm:min-w-[280px]"
            />
            <button
              type="button"
              onClick={() => void handleCreateNote()}
              disabled={creatingNote || newNotePath.trim().length === 0 || !supportedLocalNotes}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            >
              {creatingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus2 className="h-3.5 w-3.5" />}
              New note
            </button>
          </div>
        </div>

        {saveError || openError || sendError || indexError || fileError ? (
          <div className="mt-3 rounded-[8px] border border-[rgba(255,143,122,0.28)] bg-[rgba(255,143,122,0.08)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
            {saveError || openError || sendError || indexError || fileError}
          </div>
        ) : null}
        {saveSuccess || sendSuccess ? (
          <div className="mt-3 rounded-[8px] border border-[rgba(24,197,143,0.28)] bg-[rgba(24,197,143,0.08)] px-3 py-2 text-[12px] text-[var(--vk-green)]">
            {saveSuccess || sendSuccess}
          </div>
        ) : null}
        {dirty ? (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-[#f6c56f]">
            <TriangleAlert className="h-3.5 w-3.5" />
            Unsaved changes
          </div>
        ) : null}
      </div>

      {!supportedLocalNotes ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <div className="w-full max-w-xl rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-6 py-8 text-center shadow-[0_20px_48px_rgba(0,0,0,0.18)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
              <BookText className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-[18px] font-medium text-[var(--vk-text-strong)]">
              Local notes are not available for this editor
            </h2>
            <p className="mt-2 text-[14px] leading-6 text-[var(--vk-text-muted)]">
              Choose Obsidian, Logseq, VS Code, or another filesystem-backed markdown editor in Preferences to browse and edit local note files inside Conductor.
            </p>
          </div>
        </div>
      ) : indexLoading && !indexPayload ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notes workspace…
        </div>
      ) : noteFiles.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <div className="w-full max-w-xl rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-6 py-8 text-center shadow-[0_20px_48px_rgba(0,0,0,0.18)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
              <BookText className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-[18px] font-medium text-[var(--vk-text-strong)]">
              No markdown notes found yet
            </h2>
            <p className="mt-2 text-[14px] leading-6 text-[var(--vk-text-muted)]">
              Point Conductor at your notes root in Preferences, or create a new note here. If this is an Obsidian vault and Obsidian Sync is enabled there, saved changes will sync through Obsidian automatically.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden xl:grid xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/35">
            <div className="flex items-center justify-between border-b border-[var(--vk-border)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
              <span>{noteFiles.length} note{noteFiles.length === 1 ? "" : "s"}</span>
              <span>{search.trim().length > 0 ? "Filtered" : (indexPayload?.editor || "notes")}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-2">
              <NotesTree
                nodes={filteredTree}
                expandedFolders={new Set(expandedFolders)}
                selectedPath={selectedPath}
                onToggleFolder={toggleFolder}
                onSelectFile={selectFile}
              />
            </div>
          </aside>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/45 px-3 py-2">
              <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-[14px] text-[var(--vk-text-strong)]">
                    {selectedFile?.displayPath || "Select a note"}
                  </p>
                  {selectedFile ? (
                    <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                      {selectedFile.source || "notes"}
                      {selectedFile.modifiedAt ? ` · ${formatTimestamp(selectedFile.modifiedAt)}` : ""}
                      {selectedFile.sizeBytes ? ` · ${formatBytes(selectedFile.sizeBytes)}` : ""}
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-2 xl:min-w-[420px]">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      value={composerMessage}
                      onChange={(event) => setComposerMessage(event.target.value)}
                      placeholder="Optional message to send with this note"
                      className="min-h-[34px] min-w-0 flex-1 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                    />
                    <select
                      value={targetSessionId}
                      onChange={(event) => setTargetSessionId(event.target.value)}
                      className="min-h-[34px] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none"
                      disabled={sessionTargets.length === 0}
                    >
                      {sessionTargets.length === 0 ? (
                        <option value="">No active sessions</option>
                      ) : null}
                      {sessionTargets.map((session) => (
                        <option key={session.id} value={session.id}>
                          {(session.branch || session.id.slice(0, 8)).trim()} · {session.status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void sendToDispatcher()}
                      disabled={sendingDispatcher || (!selectedFile && composerMessage.trim().length === 0)}
                      className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                    >
                      {sendingDispatcher ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      Send to dispatcher
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendToSession()}
                      disabled={sendingSession || !targetSessionId || (!selectedFile && composerMessage.trim().length === 0)}
                      className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                    >
                      {sendingSession ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      Send to session
                    </button>
                    {selectedFile ? (
                      <span className="rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2.5 py-1 text-[11px] text-[var(--vk-text-muted)]">
                        Attachment · {selectedFile.name}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className={`grid min-h-0 flex-1 ${viewMode === "split" ? "xl:grid-cols-2" : "grid-cols-1"}`}>
              {viewMode !== "preview" ? (
                <div className={`min-h-0 overflow-hidden ${viewMode === "split" ? "border-b border-[var(--vk-border)] xl:border-b-0 xl:border-r" : ""}`}>
                  {fileLoading ? (
                    <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading note…
                    </div>
                  ) : (
                    <textarea
                      value={draftContent}
                      onChange={(event) => setDraftContent(event.target.value)}
                      placeholder="Select a note to start editing"
                      className="h-full min-h-0 w-full resize-none bg-[var(--vk-bg-main)] px-4 py-4 font-mono text-[13px] leading-6 text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                    />
                  )}
                </div>
              ) : null}

              {viewMode !== "edit" ? (
                <div className="min-h-0 overflow-auto bg-[var(--vk-bg-panel)]/25 px-4 py-4">
                  {draftContent.trim().length === 0 ? (
                    <div className="flex h-full min-h-[240px] items-center justify-center text-center text-[13px] text-[var(--vk-text-muted)]">
                      Markdown preview will appear here once the note has content.
                    </div>
                  ) : (
                    <article className="prose prose-invert max-w-none text-[14px] leading-7 text-[var(--vk-text-normal)] prose-headings:text-[var(--vk-text-strong)] prose-strong:text-[var(--vk-text-strong)] prose-code:text-[var(--vk-accent)] prose-pre:bg-[var(--vk-bg-main)] prose-blockquote:border-l-[var(--vk-accent)] prose-blockquote:text-[var(--vk-text-muted)]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {draftContent}
                      </ReactMarkdown>
                    </article>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
