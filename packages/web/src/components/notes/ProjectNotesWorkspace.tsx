"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookText,
  FolderOpen,
  Loader2,
  Send,
  X,
} from "lucide-react";

import type { DashboardSession } from "@/lib/types";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { isProjectDispatcherSession } from "@/lib/sessionKinds";
import { KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME } from "@/components/layout/keyboardSafeViewport";

import type {
  ViewMode,
  NoteFile,
  NotesIndexPayload,
  NoteFilePayload,
  SaveNotePayload,
  TagMap,
} from "./types";
import {
  buildNotesTree,
  filterNotesTree,
  collectFolderPaths,
  normalizeNewNotePath,
  buildNewNoteSeedContent,
  resolveWikilinkTarget,
  fuzzyMatch,
} from "./utils";
import { NotesSidebar } from "./NotesSidebar";
import { NotesToolbar } from "./NotesToolbar";
import { NotesEditor } from "./NotesEditor";
import { NotesPreview } from "./NotesPreview";
import { NotesBacklinks } from "./NotesBacklinks";
import { QuickSwitcher } from "./QuickSwitcher";
import { NotesGraph } from "./NotesGraph";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProjectNotesWorkspaceProps {
  projectId: string;
  bridgeId?: string | null;
  sessions: DashboardSession[];
  selectedSessionId?: string | null;
}

const NOTES_WORKSPACE_ROOT_CLASS_NAME = "flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] bg-[var(--vk-bg-main)]";
const NOTES_WORKSPACE_LAYOUT_CLASS_NAME = "flex min-h-0 flex-1 flex-col xl:grid xl:grid-cols-[280px_minmax(0,1fr)] xl:overflow-hidden";
const NOTES_MAIN_PANEL_CLASS_NAME = "flex min-h-[min(560px,70dvh)] flex-1 flex-col overflow-hidden xl:min-h-0";
const NOTES_MAIN_PANEL_COMPACT_CLASS_NAME = "flex min-h-0 flex-1 flex-col overflow-hidden";
const NOTES_EDITOR_PANEL_CLASS_NAME = "min-h-[320px] overflow-hidden xl:min-h-0";
const NOTES_PREVIEW_PANEL_CLASS_NAME = "min-h-[280px] overflow-auto bg-[var(--vk-bg-panel)]/25 px-4 py-4 xl:min-h-0";
const NOTES_SHEET_OVERLAY_CLASS_NAME = "fixed inset-0 z-[130] bg-black/60 backdrop-blur-[2px]";
const NOTES_SHEET_CONTENT_CLASS_NAME = `fixed inset-x-0 ${KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME} z-[131] flex flex-col overflow-hidden rounded-t-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_-24px_80px_rgba(0,0,0,0.42)]`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectNotesWorkspace({
  projectId,
  bridgeId = null,
  sessions,
  selectedSessionId = null,
}: ProjectNotesWorkspaceProps) {
  // -- Index state ---------------------------------------------------------
  const [indexPayload, setIndexPayload] = useState<NotesIndexPayload | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // -- Selection state -----------------------------------------------------
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  // -- View state ----------------------------------------------------------
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [graphOpen, setGraphOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [compactViewport, setCompactViewport] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileShareOpen, setMobileShareOpen] = useState(false);

  // -- File content state --------------------------------------------------
  const [draftContent, setDraftContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileModifiedAt, setFileModifiedAt] = useState<string | null>(null);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // -- Action state --------------------------------------------------------
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

  // -- Refs ----------------------------------------------------------------
  const latestLoadId = useRef(0);
  const recentPaths = useRef<string[]>([]);

  // -- Derived -------------------------------------------------------------
  const noteFiles = indexPayload?.files ?? [];
  const tags: TagMap = indexPayload?.tags ?? {};
  const selectedFile = useMemo(
    () => noteFiles.find((f) => f.path === selectedPath) ?? null,
    [noteFiles, selectedPath],
  );
  const dirty = draftContent !== savedContent;
  const readOnlyNote = fileTruncated || indexPayload?.writable === false;
  const supportedLocalNotes = indexPayload?.writable !== false;

  const sessionTargets = useMemo(
    () => sessions.filter((s) => !isProjectDispatcherSession(s)),
    [sessions],
  );

  const filteredTree = useMemo(() => {
    let files = noteFiles;
    // Filter by active tag
    if (activeTag && tags[activeTag]) {
      const taggedPaths = new Set(tags[activeTag]);
      files = files.filter((f) => taggedPaths.has(f.path));
    }
    // Filter by search
    if (search.trim().length > 0) {
      const q = search.trim().toLowerCase();
      files = files.filter((f) => {
        const haystack = `${f.displayPath} ${f.name} ${f.source ?? ""}`.toLowerCase();
        return haystack.includes(q);
      });
    }
    return filterNotesTree(buildNotesTree(files), search);
  }, [noteFiles, search, activeTag, tags]);

  // -- Sync selectedSessionId → targetSessionId ----------------------------
  useEffect(() => {
    if (!selectedSessionId) return;
    setTargetSessionId(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (sessionTargets.length === 0) {
      setTargetSessionId("");
      return;
    }
    if (!targetSessionId || !sessionTargets.some((s) => s.id === targetSessionId)) {
      setTargetSessionId(
        selectedSessionId && sessionTargets.some((s) => s.id === selectedSessionId)
          ? selectedSessionId
          : sessionTargets[0]?.id ?? "",
      );
    }
  }, [selectedSessionId, sessionTargets, targetSessionId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(max-width: 1279px)");
    const syncViewport = () => setCompactViewport(mediaQuery.matches);
    syncViewport();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncViewport);
      return () => mediaQuery.removeEventListener("change", syncViewport);
    }
    mediaQuery.addListener?.(syncViewport);
    return () => mediaQuery.removeListener?.(syncViewport);
  }, []);

  useEffect(() => {
    if (compactViewport && viewMode === "split") {
      setViewMode("edit");
    }
    if (!compactViewport) {
      setMobileSidebarOpen(false);
      setMobileShareOpen(false);
    }
  }, [compactViewport, viewMode]);

  useEffect(() => {
    if (compactViewport && sendSuccess) {
      setMobileShareOpen(false);
    }
  }, [compactViewport, sendSuccess]);

  // -- Index loading -------------------------------------------------------
  const refreshIndex = useCallback(() => {
    setRefreshNonce((c) => c + 1);
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
          throw new Error(
            payload && "error" in payload
              ? payload.error ?? "Failed to load notes"
              : `Failed to load notes (${response.status})`,
          );
        }
        if (cancelled) return;
        setIndexPayload((payload as NotesIndexPayload) ?? null);
      } catch (err) {
        if (cancelled) return;
        setIndexPayload(null);
        setIndexError(err instanceof Error ? err.message : "Failed to load notes workspace");
      } finally {
        if (!cancelled) setIndexLoading(false);
      }
    };

    void loadIndex();
    return () => { cancelled = true; };
  }, [bridgeId, projectId, refreshNonce]);

  // -- Auto-select first file if selection is invalid ----------------------
  useEffect(() => {
    if (noteFiles.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !noteFiles.some((f) => f.path === selectedPath)) {
      setSelectedPath(noteFiles[0]?.path ?? null);
    }
  }, [noteFiles, selectedPath]);

  // -- Expand all folders when searching -----------------------------------
  useEffect(() => {
    if (search.trim().length === 0) return;
    setExpandedFolders(collectFolderPaths(filteredTree));
  }, [filteredTree, search]);

  // -- Load selected file --------------------------------------------------
  useEffect(() => {
    if (!selectedPath) {
      setDraftContent("");
      setSavedContent("");
      setFileModifiedAt(null);
      setFileTruncated(false);
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
        const params = new URLSearchParams({ projectId, path: selectedPath });
        const response = await fetch(
          withBridgeQuery(`/api/project-notes/file?${params.toString()}`, bridgeId),
          { cache: "no-store" },
        );
        const payload = (await response.json().catch(() => null)) as
          | NoteFilePayload
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(
            payload && "error" in payload
              ? payload.error ?? "Failed to load note"
              : `Failed to load note (${response.status})`,
          );
        }
        if (cancelled || latestLoadId.current !== loadId) return;
        const note = payload as NoteFilePayload;
        setDraftContent(note.content ?? "");
        setSavedContent(note.content ?? "");
        setFileModifiedAt(note.modifiedAt ?? null);
        setFileTruncated(note.truncated === true);
      } catch (err) {
        if (cancelled || latestLoadId.current !== loadId) return;
        setDraftContent("");
        setSavedContent("");
        setFileModifiedAt(null);
        setFileTruncated(false);
        setFileError(err instanceof Error ? err.message : "Failed to load note");
      } finally {
        if (!cancelled && latestLoadId.current === loadId) setFileLoading(false);
      }
    };

    void loadFile();
    return () => { cancelled = true; };
  }, [bridgeId, projectId, refreshNonce, selectedPath]);

  // -- Save ----------------------------------------------------------------
  const saveCurrentNote = useCallback(async () => {
    if (!selectedFile) return null;
    if (fileTruncated) {
      setSaveError("This note was truncated for safety. Open it externally to edit the full file.");
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
        throw new Error(
          payload && "error" in payload
            ? payload.error ?? "Failed to save note"
            : `Failed to save note (${response.status})`,
        );
      }
      const saved = payload as SaveNotePayload;
      setSavedContent(draftContent);
      setFileModifiedAt(saved.modifiedAt ?? null);
      setSaveSuccess(saved.created ? "Note created." : "Note saved.");
      refreshIndex();
      return saved;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save note");
      return null;
    } finally {
      setSaving(false);
    }
  }, [bridgeId, draftContent, fileModifiedAt, fileTruncated, projectId, refreshIndex, selectedFile]);

  // -- Open externally -----------------------------------------------------
  const handleOpenExternally = useCallback(async () => {
    if (!selectedFile) return;
    if (dirty) {
      const saved = await saveCurrentNote();
      if (!saved) return;
    }
    setOpening(true);
    setOpenError(null);
    try {
      const response = await fetch(withBridgeQuery("/api/project-notes/open", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, path: selectedFile.path }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to open note (${response.status})`);
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Failed to open note");
    } finally {
      setOpening(false);
    }
  }, [bridgeId, dirty, projectId, saveCurrentNote, selectedFile]);

  // -- Create note ---------------------------------------------------------
  const handleCreateNote = useCallback(async () => {
    const normalizedPath = normalizeNewNotePath(newNotePath);
    if (!normalizedPath || creatingNote) return;
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
        throw new Error(
          payload && "error" in payload
            ? payload.error ?? "Failed to create note"
            : `Failed to create note (${response.status})`,
        );
      }
      const created = payload as SaveNotePayload;
      setNewNotePath("");
      setSelectedPath(created.path);
      if (compactViewport) {
        setMobileSidebarOpen(false);
        setGraphOpen(false);
        setViewMode("edit");
      }
      setSaveSuccess("Note created.");
      refreshIndex();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to create note");
    } finally {
      setCreatingNote(false);
    }
  }, [bridgeId, compactViewport, creatingNote, newNotePath, projectId, refreshIndex]);

  // -- Daily note ----------------------------------------------------------
  const handleDailyNote = useCallback(async () => {
    try {
      const response = await fetch(withBridgeQuery("/api/project-notes/daily", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { path: string; displayPath: string; created: boolean; error?: string }
        | null;
      if (!response.ok || (payload && "error" in payload)) {
        throw new Error(payload?.error ?? `Failed to create daily note (${response.status})`);
      }
      if (payload?.path) {
        setSelectedPath(payload.path);
        if (compactViewport) {
          setMobileSidebarOpen(false);
          setGraphOpen(false);
          setViewMode("edit");
        }
        // Expand daily folder
        setExpandedFolders((prev) =>
          prev.includes("daily") ? prev : [...prev, "daily"],
        );
        refreshIndex();
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to create daily note");
    }
  }, [bridgeId, compactViewport, projectId, refreshIndex]);

  // -- Send to dispatcher --------------------------------------------------
  const sendToDispatcher = useCallback(async () => {
    if ((!selectedFile && composerMessage.trim().length === 0) || sendingDispatcher) return;
    if (dirty) {
      const saved = await saveCurrentNote();
      if (!saved) return;
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
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send note to dispatcher");
    } finally {
      setSendingDispatcher(false);
    }
  }, [bridgeId, composerMessage, dirty, projectId, saveCurrentNote, selectedFile, sendingDispatcher]);

  // -- Send to session -----------------------------------------------------
  const sendToSession = useCallback(async () => {
    if ((!selectedFile && composerMessage.trim().length === 0) || !targetSessionId || sendingSession) return;
    if (dirty) {
      const saved = await saveCurrentNote();
      if (!saved) return;
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
      const targetSession = sessionTargets.find((s) => s.id === targetSessionId);
      setSendSuccess(
        targetSession
          ? `Sent note to ${targetSession.branch || targetSession.id.slice(0, 8)}.`
          : "Sent note to session.",
      );
      setComposerMessage("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send note to session");
    } finally {
      setSendingSession(false);
    }
  }, [bridgeId, composerMessage, dirty, saveCurrentNote, selectedFile, sendingSession, sessionTargets, targetSessionId]);

  // -- Folder toggle -------------------------------------------------------
  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((current) =>
      current.includes(path) ? current.filter((e) => e !== path) : [...current, path],
    );
  }, []);

  // -- File select ---------------------------------------------------------
  const selectFile = useCallback((path: string) => {
    if (path === selectedPath) {
      if (compactViewport) setMobileSidebarOpen(false);
      return;
    }
    if (dirty && typeof window !== "undefined") {
      const discard = window.confirm("Discard unsaved note changes and switch notes?");
      if (!discard) return;
    }
    setSelectedPath(path);
    if (compactViewport) {
      setMobileSidebarOpen(false);
      setGraphOpen(false);
      setViewMode("edit");
    }
    // Track recent files
    recentPaths.current = [path, ...recentPaths.current.filter((p) => p !== path)].slice(0, 20);
  }, [compactViewport, dirty, selectedPath]);

  // -- Wikilink navigation -------------------------------------------------
  const handleWikilinkClick = useCallback((target: string) => {
    const resolved = resolveWikilinkTarget(target, noteFiles);
    if (resolved) {
      selectFile(resolved);
    } else {
      // Create the note
      const normalizedPath = target.includes("/")
        ? `${target}.md`
        : `${target}.md`;
      setNewNotePath(normalizedPath);
    }
  }, [noteFiles, selectFile]);

  // -- Tag click -----------------------------------------------------------
  const handleTagClick = useCallback((tag: string) => {
    setActiveTag((prev) => (prev === tag ? null : tag));
  }, []);

  // -- Keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setQuickSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // -- Quick switcher select -----------------------------------------------
  const handleQuickSwitchSelect = useCallback((path: string) => {
    setQuickSwitcherOpen(false);
    selectFile(path);
  }, [selectFile]);

  // -- Error/success aggregation -------------------------------------------
  const anyError = saveError || openError || sendError || indexError || fileError;
  const anySuccess = saveSuccess || sendSuccess;

  // -- Label ---------------------------------------------------------------
  const rootLabel = indexPayload?.notesRoot
    ? indexPayload.notesRoot
    : indexPayload?.editor?.trim().toLowerCase() === "notion"
      ? "Notion"
      : "Project markdown files";
  const effectiveViewMode: ViewMode = compactViewport && viewMode === "split" ? "edit" : viewMode;

  // -- Render --------------------------------------------------------------
  return (
    <div className={NOTES_WORKSPACE_ROOT_CLASS_NAME}>
      {/* Toolbar */}
      <NotesToolbar
        viewMode={effectiveViewMode}
        onViewModeChange={setViewMode}
        onSave={() => void saveCurrentNote()}
        onRefresh={refreshIndex}
        onOpenExternally={() => void handleOpenExternally()}
        onDailyNote={() => void handleDailyNote()}
        onToggleGraph={() => setGraphOpen((v) => !v)}
        graphOpen={graphOpen}
        saving={saving}
        dirty={dirty}
        indexLoading={indexLoading}
        opening={opening}
        selectedFile={selectedFile}
        fileTruncated={fileTruncated}
        editorName={indexPayload?.editor}
        canSave={supportedLocalNotes}
        compact={compactViewport}
        onOpenFiles={() => setMobileSidebarOpen(true)}
        onOpenShare={() => setMobileShareOpen(true)}
      />

      {/* Header info bar */}
      <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 py-2 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[14px] text-[var(--vk-text-strong)]">
              {projectId} · {indexPayload?.editor || "markdown"}
            </p>
            <p className="truncate text-[12px] text-[var(--vk-text-muted)]">
              {rootLabel}
              {activeTag ? ` · Filtered by #${activeTag}` : ""}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={newNotePath}
              onChange={(e) => setNewNotePath(e.target.value)}
              placeholder="New note path, e.g. architecture/overview.md"
              className="min-h-[34px] min-w-0 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)] sm:min-w-[260px]"
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateNote(); }}
            />
            <button
              type="button"
              onClick={() => void handleCreateNote()}
              disabled={creatingNote || newNotePath.trim().length === 0 || !supportedLocalNotes}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
            >
              {creatingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookText className="h-3.5 w-3.5" />}
              New note
            </button>
          </div>
        </div>

        {/* Error/success banners */}
        {anyError ? (
          <div className="mt-2 rounded-[8px] border border-[rgba(255,143,122,0.28)] bg-[rgba(255,143,122,0.08)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
            {anyError}
          </div>
        ) : null}
        {anySuccess ? (
          <div className="mt-2 rounded-[8px] border border-[rgba(24,197,143,0.28)] bg-[rgba(24,197,143,0.08)] px-3 py-2 text-[12px] text-[var(--vk-green)]">
            {anySuccess}
          </div>
        ) : null}
        {dirty ? (
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[#f6c56f]">
            ● Unsaved changes
          </div>
        ) : null}
        {fileTruncated ? (
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-[#f6c56f]">
            This note is too large to edit safely. The preview is read-only.
          </div>
        ) : null}
      </div>

      {/* Main content area */}
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
              Point Conductor at your notes root in Preferences, or create a new note above.
            </p>
          </div>
        </div>
      ) : graphOpen ? (
        /* Graph View */
        <NotesGraph
          projectId={projectId}
          bridgeId={bridgeId}
          noteFiles={noteFiles}
          selectedPath={selectedPath}
          onNavigate={selectFile}
        />
      ) : (
        /* Normal view: sidebar + editor/preview */
        <div className={compactViewport ? "min-h-0 flex-1" : NOTES_WORKSPACE_LAYOUT_CLASS_NAME}>
          {/* Sidebar */}
          {compactViewport ? null : (
            <NotesSidebar
              noteFiles={noteFiles}
              selectedPath={selectedPath}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              onSelectFile={selectFile}
              search={search}
              onSearchChange={setSearch}
              editorLabel={indexPayload?.editor}
              tags={tags}
              onTagClick={handleTagClick}
            />
          )}

          {/* Main panel */}
          <div className={compactViewport ? NOTES_MAIN_PANEL_COMPACT_CLASS_NAME : NOTES_MAIN_PANEL_CLASS_NAME}>
            {/* File info + send-to bar */}
            <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/45 px-3 py-2">
              <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-[14px] text-[var(--vk-text-strong)]">
                    {selectedFile?.displayPath || "Select a note"}
                  </p>
                  {selectedFile ? (
                    <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                      {selectedFile.source || "notes"}
                      {selectedFile.modifiedAt ? ` · ${new Date(selectedFile.modifiedAt).toLocaleString()}` : ""}
                      {selectedFile.sizeBytes ? ` · ${(selectedFile.sizeBytes / 1024).toFixed(1)} KB` : ""}
                    </p>
                  ) : null}
                </div>

                {/* Send-to controls */}
                {compactViewport ? null : (
                  <div className="grid gap-2 xl:min-w-[420px]">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        value={composerMessage}
                        onChange={(e) => setComposerMessage(e.target.value)}
                        placeholder="Optional message to send with this note"
                        className="min-h-[34px] min-w-0 flex-1 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                      />
                      <select
                        value={targetSessionId}
                        onChange={(e) => setTargetSessionId(e.target.value)}
                        className="min-h-[34px] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none"
                        disabled={sessionTargets.length === 0}
                      >
                        {sessionTargets.length === 0 ? (
                          <option value="">No active sessions</option>
                        ) : null}
                        {sessionTargets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {(s.branch || s.id.slice(0, 8)).trim()} · {s.status}
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
                        {sendingDispatcher ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✦"}
                        Send to dispatcher
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendToSession()}
                        disabled={sendingSession || !targetSessionId || (!selectedFile && composerMessage.trim().length === 0)}
                        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                      >
                        {sendingSession ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "→"}
                        Send to session
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Editor / Preview area */}
            <div className={`grid min-h-0 flex-1 ${effectiveViewMode === "split" ? "xl:grid-cols-2" : "grid-cols-1"}`}>
              {effectiveViewMode !== "preview" ? (
                <div className={`${NOTES_EDITOR_PANEL_CLASS_NAME} ${effectiveViewMode === "split" ? "border-b border-[var(--vk-border)] xl:border-b-0 xl:border-r" : ""}`}>
                  {fileLoading ? (
                    <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading note…
                    </div>
                  ) : (
                    <NotesEditor
                      value={draftContent}
                      onChange={setDraftContent}
                      readOnly={readOnlyNote}
                      placeholder="Select a note to start editing"
                      onWikilinkClick={handleWikilinkClick}
                      onSave={() => void saveCurrentNote()}
                      onQuickSwitch={() => setQuickSwitcherOpen(true)}
                    />
                  )}
                </div>
              ) : null}

              {effectiveViewMode !== "edit" ? (
                <div className={NOTES_PREVIEW_PANEL_CLASS_NAME}>
                  <NotesPreview
                    content={draftContent}
                    onWikilinkClick={handleWikilinkClick}
                    noteFiles={noteFiles}
                  />
                </div>
              ) : null}
            </div>

            {/* Backlinks panel */}
            <NotesBacklinks
              projectId={projectId}
              bridgeId={bridgeId}
              notePath={selectedPath}
              onNavigate={selectFile}
            />
          </div>
        </div>
      )}

      <Dialog.Root open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={NOTES_SHEET_OVERLAY_CLASS_NAME} />
          <Dialog.Content className={NOTES_SHEET_CONTENT_CLASS_NAME}>
            <div className="flex items-center justify-between border-b border-[var(--vk-border)] px-4 py-3">
              <div>
                <Dialog.Title className="text-[14px] font-medium text-[var(--vk-text-strong)]">
                  Browse notes
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-[var(--vk-text-muted)]">
                  Jump between files without crowding the editor on mobile.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--vk-border)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <NotesSidebar
                noteFiles={noteFiles}
                selectedPath={selectedPath}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                onSelectFile={selectFile}
                search={search}
                onSearchChange={setSearch}
                editorLabel={indexPayload?.editor}
                tags={tags}
                onTagClick={handleTagClick}
                className="h-full max-h-none border-b-0 xl:border-r-0"
              />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={mobileShareOpen} onOpenChange={setMobileShareOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={NOTES_SHEET_OVERLAY_CLASS_NAME} />
          <Dialog.Content className={NOTES_SHEET_CONTENT_CLASS_NAME}>
            <div className="flex items-center justify-between border-b border-[var(--vk-border)] px-4 py-3">
              <div>
                <Dialog.Title className="text-[14px] font-medium text-[var(--vk-text-strong)]">
                  Share note
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-[var(--vk-text-muted)]">
                  Send the current note to the dispatcher or an active session.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--vk-border)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4">
              <div className="rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]/35 px-3 py-3">
                <p className="text-[13px] font-medium text-[var(--vk-text-strong)]">
                  {selectedFile?.displayPath || "No note selected"}
                </p>
                {selectedFile ? (
                  <p className="mt-1 text-[11px] text-[var(--vk-text-muted)]">
                    {selectedFile.source || "notes"}
                    {selectedFile.modifiedAt ? ` · ${new Date(selectedFile.modifiedAt).toLocaleString()}` : ""}
                  </p>
                ) : null}
              </div>
              <label className="grid gap-2 text-[12px] text-[var(--vk-text-muted)]">
                <span>Optional message</span>
                <input
                  value={composerMessage}
                  onChange={(e) => setComposerMessage(e.target.value)}
                  placeholder="Optional message to send with this note"
                  className="min-h-[40px] rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                />
              </label>
              <label className="grid gap-2 text-[12px] text-[var(--vk-text-muted)]">
                <span>Target session</span>
                <select
                  value={targetSessionId}
                  onChange={(e) => setTargetSessionId(e.target.value)}
                  className="min-h-[40px] rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[13px] text-[var(--vk-text-normal)] outline-none"
                  disabled={sessionTargets.length === 0}
                >
                  {sessionTargets.length === 0 ? (
                    <option value="">No active sessions</option>
                  ) : null}
                  {sessionTargets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.branch || s.id.slice(0, 8)).trim()} · {s.status}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-auto flex flex-col gap-2 pb-[env(safe-area-inset-bottom)]">
                <button
                  type="button"
                  onClick={() => void sendToDispatcher()}
                  disabled={sendingDispatcher || (!selectedFile && composerMessage.trim().length === 0)}
                  className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-[10px] border border-[var(--vk-border)] px-4 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                >
                  {sendingDispatcher ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                  Send to dispatcher
                </button>
                <button
                  type="button"
                  onClick={() => void sendToSession()}
                  disabled={sendingSession || !targetSessionId || (!selectedFile && composerMessage.trim().length === 0)}
                  className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-[10px] border border-[var(--vk-accent)] bg-[rgba(139,92,246,0.14)] px-4 text-[13px] text-[var(--vk-text-strong)] hover:bg-[rgba(139,92,246,0.2)] disabled:opacity-60"
                >
                  {sendingSession ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send to session
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Quick Switcher overlay */}
      <QuickSwitcher
        open={quickSwitcherOpen}
        onOpenChange={setQuickSwitcherOpen}
        files={noteFiles.map((f) => ({ path: f.path, name: f.name, displayPath: f.displayPath }))}
        onSelect={handleQuickSwitchSelect}
        recentPaths={recentPaths.current}
      />
    </div>
  );
}
