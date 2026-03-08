"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2, Pencil, Plus, Search } from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { cn } from "@/lib/cn";

type BoardRole =
  | "intake"
  | "ready"
  | "dispatching"
  | "inProgress"
  | "needsInput"
  | "blocked"
  | "errored"
  | "review"
  | "merge"
  | "done"
  | "cancelled";

type BoardTask = {
  id: string;
  text: string;
  checked: boolean;
  agent: string | null;
  project: string | null;
  type: string | null;
  priority: string | null;
  taskRef: string | null;
  attemptRef: string | null;
};

type BoardColumn = {
  role: BoardRole;
  heading: string;
  tasks: BoardTask[];
};

type BoardResponse = {
  projectId: string;
  boardPath: string;
  workspacePath: string;
  columns: BoardColumn[];
  primaryRoles: BoardRole[];
  watcherHint?: string;
};

type ContextFile = {
  path: string;
  name: string;
  kind: "image" | "file";
  source?: string;
  sizeBytes?: number | null;
};

type ContextFilesResponse = {
  files: ContextFile[];
};

type ProjectSession = {
  id: string;
  branch: string | null;
  summary: string | null;
  status: string;
  issueId?: string | null;
  lastActivityAt?: string | null;
  metadata?: Record<string, string> | null;
};

interface WorkspaceKanbanProps {
  projectId: string | null;
  defaultAgent: string;
  agentOptions: string[];
}

const ROLE_COLOR: Record<BoardRole, string> = {
  intake: "#3c83f6",
  ready: "#f59f0a",
  dispatching: "#fb923c",
  inProgress: "#f59f0a",
  needsInput: "#eab308",
  blocked: "#d53946",
  errored: "#ef4444",
  review: "#895af6",
  merge: "#06b6d4",
  done: "#21c45d",
  cancelled: "#6b7280",
};

const ROLE_LABEL: Record<BoardRole, string> = {
  intake: "To do",
  ready: "Ready",
  dispatching: "Dispatching",
  inProgress: "In progress",
  needsInput: "Needs input",
  blocked: "Blocked",
  errored: "Errored",
  review: "In review",
  merge: "Merge",
  done: "Done",
  cancelled: "Cancelled",
};
const ACTIVE_BOARD_REFRESH_MS = 10_000;
const HIDDEN_BOARD_REFRESH_MS = 30_000;

function toRole(value: string): BoardRole {
  const roles: BoardRole[] = ["intake", "ready", "dispatching", "inProgress", "needsInput", "blocked", "errored", "review", "merge", "done", "cancelled"];
  return roles.includes(value as BoardRole) ? (value as BoardRole) : "intake";
}

function splitTaskText(text: string): { title: string; description: string } {
  const [title, ...rest] = text.split(" - ");
  return {
    title: (title ?? text).trim(),
    description: rest.join(" - ").trim(),
  };
}

function formatAgentLabel(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatFileSize(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function boardsEqual(left: BoardResponse | null, right: BoardResponse): boolean {
  if (!left) return false;
  if (
    left.projectId !== right.projectId ||
    left.boardPath !== right.boardPath ||
    left.workspacePath !== right.workspacePath ||
    left.watcherHint !== right.watcherHint ||
    left.primaryRoles.length !== right.primaryRoles.length ||
    left.columns.length !== right.columns.length
  ) {
    return false;
  }

  for (let index = 0; index < left.primaryRoles.length; index += 1) {
    if (left.primaryRoles[index] !== right.primaryRoles[index]) {
      return false;
    }
  }

  for (let columnIndex = 0; columnIndex < left.columns.length; columnIndex += 1) {
    const leftColumn = left.columns[columnIndex];
    const rightColumn = right.columns[columnIndex];
    if (
      leftColumn.role !== rightColumn.role ||
      leftColumn.heading !== rightColumn.heading ||
      leftColumn.tasks.length !== rightColumn.tasks.length
    ) {
      return false;
    }

    for (let taskIndex = 0; taskIndex < leftColumn.tasks.length; taskIndex += 1) {
      const leftTask = leftColumn.tasks[taskIndex];
      const rightTask = rightColumn.tasks[taskIndex];
      if (
        leftTask.id !== rightTask.id ||
        leftTask.text !== rightTask.text ||
        leftTask.checked !== rightTask.checked ||
        leftTask.agent !== rightTask.agent ||
        leftTask.project !== rightTask.project ||
        leftTask.type !== rightTask.type ||
        leftTask.priority !== rightTask.priority ||
        leftTask.taskRef !== rightTask.taskRef ||
        leftTask.attemptRef !== rightTask.attemptRef
      ) {
        return false;
      }
    }
  }

  return true;
}

function formatLinkedSessionLabel(session: ProjectSession): string {
  return session.branch?.trim() || session.summary?.trim() || session.id.slice(0, 8);
}

function getTaskLinkKey(task: BoardTask): string {
  return task.taskRef?.trim() || task.id;
}

function getSessionAgent(session: ProjectSession): string | null {
  const candidate = session.metadata?.agent;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function formatSessionStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "working" || normalized === "running") return "Running";
  if (normalized === "done") return "Done";
  if (normalized === "killed") return "Interrupted";
  if (normalized === "errored") return "Errored";
  if (normalized === "archived") return "Archived";
  return status
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function sessionStatusPillClass(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "working" || normalized === "running") {
    return "border-[rgba(60,131,246,0.35)] bg-[rgba(60,131,246,0.12)] text-[#8db8ff]";
  }
  if (normalized === "done") {
    return "border-[rgba(84,176,79,0.35)] bg-[rgba(84,176,79,0.12)] text-[var(--vk-green)]";
  }
  if (normalized === "killed" || normalized === "archived") {
    return "border-[rgba(143,143,143,0.35)] bg-[rgba(143,143,143,0.10)] text-[var(--vk-text-muted)]";
  }
  if (normalized === "errored") {
    return "border-[rgba(210,81,81,0.35)] bg-[rgba(210,81,81,0.12)] text-[var(--vk-red)]";
  }
  return "border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] text-[var(--vk-text-muted)]";
}

function compareProjectSessions(left: ProjectSession, right: ProjectSession, primaryId: string | null): number {
  if (primaryId) {
    if (left.id === primaryId && right.id !== primaryId) return -1;
    if (right.id === primaryId && left.id !== primaryId) return 1;
  }
  const leftTime = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
  const rightTime = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
  return rightTime - leftTime;
}

export function WorkspaceKanban({ projectId, defaultAgent, agentOptions }: WorkspaceKanbanProps) {
  const router = useRouter();
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerRole, setComposerRole] = useState<BoardRole>("intake");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState(defaultAgent);
  const [taskType, setTaskType] = useState("feature");
  const [priority, setPriority] = useState("normal");
  const [contextNotes, setContextNotes] = useState("");
  const [selectedContextPaths, setSelectedContextPaths] = useState<string[]>([]);
  const [contextSearch, setContextSearch] = useState("");
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [projectSessions, setProjectSessions] = useState<ProjectSession[]>([]);
  const [editingTask, setEditingTask] = useState<{ task: BoardTask; role: BoardRole } | null>(null);
  const [editRole, setEditRole] = useState<BoardRole>("intake");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAgent, setEditAgent] = useState(defaultAgent);
  const [editTaskType, setEditTaskType] = useState("feature");
  const [editPriority, setEditPriority] = useState("normal");
  const [editLinkedSession, setEditLinkedSession] = useState("");
  const [editingBusy, setEditingBusy] = useState(false);
  const [editingError, setEditingError] = useState<string | null>(null);
  const [draggingTask, setDraggingTask] = useState<{ taskId: string; role: BoardRole } | null>(null);
  const hasLoadedBoardRef = useRef(false);
  const boardRequestInFlightRef = useRef(false);

  const orderedAgentOptions = useMemo(() => {
    const normalized = [...new Set(agentOptions.filter(Boolean))];
    if (!normalized.includes(defaultAgent)) {
      normalized.unshift(defaultAgent);
    }
    return normalized;
  }, [agentOptions, defaultAgent]);

  useEffect(() => {
    if (!orderedAgentOptions.includes(agent)) {
      setAgent(orderedAgentOptions[0] ?? defaultAgent);
    }
  }, [agent, defaultAgent, orderedAgentOptions]);

  useEffect(() => {
    if (!orderedAgentOptions.includes(editAgent)) {
      setEditAgent(orderedAgentOptions[0] ?? defaultAgent);
    }
  }, [defaultAgent, editAgent, orderedAgentOptions]);

  useEffect(() => {
    if (!composerOpen || !projectId) return;
    let cancelled = false;

    const loadContextFiles = async () => {
      setContextLoading(true);
      setContextError(null);
      try {
        const res = await fetch(`/api/context-files?projectId=${encodeURIComponent(projectId)}`);
        const payload = (await res.json().catch(() => null)) as
          | ContextFilesResponse
          | { error?: string }
          | null;
        if (!res.ok) {
          throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load context files: ${res.status}`);
        }
        if (cancelled) return;
        const files = Array.isArray((payload as ContextFilesResponse | null)?.files)
          ? (payload as ContextFilesResponse).files
          : [];
        setContextFiles(files);
      } catch (err) {
        if (cancelled) return;
        setContextFiles([]);
        setContextError(err instanceof Error ? err.message : "Failed to load context files");
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    };

    void loadContextFiles();
    return () => {
      cancelled = true;
    };
  }, [composerOpen, projectId]);

  useEffect(() => {
    if (!projectId || (!composerOpen && !editingTask)) return;
    let cancelled = false;

    const loadProjectSessions = async () => {
      try {
        const res = await fetch(`/api/sessions?project=${encodeURIComponent(projectId)}`);
        const payload = (await res.json().catch(() => null)) as
          | { sessions?: ProjectSession[] }
          | ProjectSession[]
          | null;
        if (!res.ok) {
          throw new Error(`Failed to load sessions: ${res.status}`);
        }
        if (cancelled) return;
        const sessions = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.sessions)
            ? payload.sessions
            : [];
        setProjectSessions(sessions);
      } catch {
        if (!cancelled) {
          setProjectSessions([]);
        }
      }
    };

    void loadProjectSessions();
    return () => {
      cancelled = true;
    };
  }, [composerOpen, editingTask, projectId]);

  useEffect(() => {
    hasLoadedBoardRef.current = false;
  }, [projectId]);

  const loadBoard = useCallback(async (options?: { silent?: boolean }) => {
    if (!projectId) {
      setBoard(null);
      setError(null);
      setLoading(false);
      hasLoadedBoardRef.current = false;
      return;
    }
    if (boardRequestInFlightRef.current) {
      return;
    }

    boardRequestInFlightRef.current = true;

    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const res = await fetch(`/api/boards?projectId=${encodeURIComponent(projectId)}`);
      const data = (await res.json().catch(() => null)) as BoardResponse | { error?: string } | null;
      if (!res.ok) {
        throw new Error((data as { error?: string } | null)?.error ?? `Failed to load board: ${res.status}`);
      }

      const nextBoard = data as BoardResponse;
      hasLoadedBoardRef.current = true;
      setBoard((current) => (boardsEqual(current, nextBoard) ? current : nextBoard));
      setError(null);
    } catch (err) {
      if (!options?.silent || !hasLoadedBoardRef.current) {
        setBoard(null);
        setError(err instanceof Error ? err.message : "Failed to load board");
      }
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
      boardRequestInFlightRef.current = false;
    }
  }, [projectId]);

  useEffect(() => {
    void loadBoard({ silent: false });
  }, [loadBoard]);

  useEffect(() => {
    if (!projectId) return;

    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void loadBoard({ silent: true });
    };

    let timeoutId: number | null = null;
    const scheduleRefresh = () => {
      const delay = document.visibilityState === "visible"
        ? ACTIVE_BOARD_REFRESH_MS
        : HIDDEN_BOARD_REFRESH_MS;
      timeoutId = window.setTimeout(() => {
        refresh();
        scheduleRefresh();
      }, delay);
    };
    scheduleRefresh();

    window.addEventListener("focus", refresh);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadBoard, projectId]);

  const visibleColumns = useMemo(() => {
    const query = search.trim().toLowerCase();
    const source = board?.columns ?? [];

    return source
      .map((column) => {
        if (!query) return column;
        return {
          ...column,
          tasks: column.tasks.filter((task) => {
            const haystack = `${task.text} ${task.agent ?? ""} ${task.type ?? ""} ${task.priority ?? ""}`.toLowerCase();
            return haystack.includes(query);
          }),
        };
      });
  }, [board?.columns, search]);

  const filteredContextFiles = useMemo(() => {
    const query = contextSearch.trim().toLowerCase();
    if (!query) return contextFiles;
    return contextFiles.filter((file) => {
      const haystack = `${file.path} ${file.name} ${file.source ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [contextFiles, contextSearch]);
  const editLinkedSessionOptions = useMemo(() => {
    if (!editingTask) return projectSessions;
    const taskKey = getTaskLinkKey(editingTask.task);
    return [...projectSessions].sort((left, right) => {
      const leftRelated = left.id === editingTask.task.attemptRef || left.issueId?.trim() === taskKey;
      const rightRelated = right.id === editingTask.task.attemptRef || right.issueId?.trim() === taskKey;
      if (leftRelated !== rightRelated) return leftRelated ? -1 : 1;
      return compareProjectSessions(left, right, editingTask.task.attemptRef);
    });
  }, [editingTask, projectSessions]);

  function openComposer(role: BoardRole) {
    setComposerRole(role);
    setComposerOpen(true);
    setSubmitError(null);
    setContextNotes("");
    setContextSearch("");
    setSelectedContextPaths([]);
    setUploadFiles([]);
  }

  function toggleContextPath(path: string) {
    setSelectedContextPaths((current) => (
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    ));
  }

  function removeUploadFile(file: File) {
    setUploadFiles((current) => current.filter((entry) => (
      entry.name !== file.name || entry.size !== file.size || entry.lastModified !== file.lastModified
    )));
  }

  async function handleCreateTask() {
    if (!projectId || !title.trim()) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      let uploadedPaths: string[] = [];
      if (uploadFiles.length > 0) {
        const formData = new FormData();
        formData.append("projectId", projectId);
        for (const file of uploadFiles) {
          formData.append("files", file);
        }
        const uploadRes = await fetch("/api/attachments", {
          method: "POST",
          body: formData,
        });
        const uploadPayload = (await uploadRes.json().catch(() => null)) as
          | { files?: Array<{ path?: string }>; error?: string }
          | null;
        if (!uploadRes.ok) {
          throw new Error(uploadPayload?.error ?? `Upload failed: ${uploadRes.status}`);
        }
        uploadedPaths = (uploadPayload?.files ?? [])
          .map((entry) => entry.path?.trim())
          .filter((value): value is string => Boolean(value));
      }

      const attachments = [...new Set([...selectedContextPaths, ...uploadedPaths])];
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: title.trim(),
          description: description.trim() || undefined,
          contextNotes: contextNotes.trim() || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          agent,
          role: composerRole,
          type: taskType.trim() || undefined,
          priority: priority.trim() || undefined,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | BoardResponse
        | { error?: string }
        | null;

      if (!res.ok) {
        throw new Error((payload as { error?: string } | null)?.error ?? `Failed to create task: ${res.status}`);
      }

      setBoard((current) => {
        if (!payload || !("columns" in payload)) return current;
        const next = payload as BoardResponse;
        return {
          ...(current ?? next),
          ...next,
        };
      });

      setTitle("");
      setDescription("");
      setTaskType("feature");
      setPriority("normal");
      setContextNotes("");
      setSelectedContextPaths([]);
      setContextSearch("");
      setUploadFiles([]);
      setComposerOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  }

  const mutatingRef = useRef(false);

  async function handleBoardMutation(payload: Record<string, unknown>) {
    if (!projectId || mutatingRef.current) return;
    mutatingRef.current = true;
    try {
    const res = await fetch("/api/boards", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        ...payload,
      }),
    });
    const data = (await res.json().catch(() => null)) as BoardResponse | { error?: string } | null;
    if (!res.ok) {
      throw new Error((data as { error?: string } | null)?.error ?? `Failed to update board: ${res.status}`);
    }
    const nextBoard = data as BoardResponse;
    setBoard((current) => (boardsEqual(current, nextBoard) ? current : nextBoard));
    setError(null);
    } finally {
      mutatingRef.current = false;
    }
  }

  function openEditor(task: BoardTask, role: BoardRole) {
    const { title: nextTitle, description: nextDescription } = splitTaskText(task.text);
    setEditingTask({ task, role });
    setEditRole(role);
    setEditTitle(nextTitle);
    setEditDescription(nextDescription);
    setEditAgent(task.agent ?? orderedAgentOptions[0] ?? defaultAgent);
    setEditTaskType(task.type ?? "feature");
    setEditPriority(task.priority ?? "normal");
    setEditLinkedSession(task.attemptRef ?? "");
    setEditingError(null);
  }

  function closeEditor() {
    if (editingBusy) return;
    setEditingTask(null);
    setEditingError(null);
  }

  async function handleSaveEdit() {
    if (!editingTask || !editTitle.trim()) return;
    setEditingBusy(true);
    setEditingError(null);
    try {
      await handleBoardMutation({
        taskId: editingTask.task.id,
        role: editRole,
        title: editTitle.trim(),
        description: editDescription,
        agent: editAgent,
        type: editTaskType,
        priority: editPriority,
        attemptRef: editLinkedSession,
        taskRef: editLinkedSession
          ? (editingTask.task.taskRef ?? editingTask.task.id)
          : (editingTask.task.taskRef ?? ""),
      });
      setEditingTask(null);
    } catch (err) {
      setEditingError(err instanceof Error ? err.message : "Failed to update task");
    } finally {
      setEditingBusy(false);
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-[14px] text-[var(--vk-text-muted)]">
        Select a workspace to view its Kanban board.
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[var(--vk-border)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-[3px] border border-[var(--vk-border)] p-px">
            <span className="rounded-[2px] bg-[var(--vk-bg-active)] px-3 py-1 text-[13px] text-[var(--vk-text-strong)]">Active</span>
            <span className="px-3 py-1 text-[13px] text-[var(--vk-text-muted)]">All</span>
            <span className="px-3 py-1 text-[13px] text-[var(--vk-text-muted)]">Backlog</span>
            <span className="px-3 py-1 text-[13px] text-[var(--vk-text-muted)]">Cancelled</span>
          </div>

          <div className="ml-auto flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:min-w-[220px] sm:flex-nowrap sm:flex-none">
            <label className="flex h-[31px] min-w-0 flex-1 items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 sm:min-w-[200px] sm:w-[240px] sm:flex-none">
              <Search className="h-3.5 w-3.5 text-[var(--vk-text-muted)]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search tasks..."
                className="ml-2 w-full bg-transparent text-[14px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
              />
            </label>

            <button
              type="button"
              onClick={() => openComposer("intake")}
              className="inline-flex h-[31px] w-full items-center justify-center gap-1 rounded-[3px] bg-[var(--vk-bg-active)] px-3 text-[14px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] sm:w-auto"
            >
              <span>New Issue</span>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {board?.watcherHint && (
          <p className="pt-2 text-[12px] text-[var(--vk-text-muted)]">{board.watcherHint}</p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[var(--vk-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="ml-2 text-[14px]">Loading board...</span>
          </div>
        ) : error ? (
          <div className="rounded-[4px] border border-[color:color-mix(in_srgb,var(--vk-red)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[13px] text-[var(--vk-red)]">
            {error}
          </div>
        ) : (
          <div
            className="grid min-w-[980px] gap-0 rounded-[4px] border border-[var(--vk-border)]"
            style={{ gridTemplateColumns: `repeat(${Math.max(visibleColumns.length, 1)}, minmax(240px, 1fr))` }}
          >
            {visibleColumns.map((column, columnIndex) => (
              <article
                key={column.role}
                className={cn(
                  "flex min-h-[540px] flex-col border-r border-[var(--vk-border)] bg-[var(--vk-bg-panel)]",
                  columnIndex === visibleColumns.length - 1 && "border-r-0",
                )}
              >
                <header className="flex h-[41px] items-center border-b border-[var(--vk-border)] px-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ROLE_COLOR[column.role] }} />
                  <span className="ml-2 text-[14px] text-[var(--vk-text-normal)]">
                    {column.heading || ROLE_LABEL[column.role]}
                  </span>
                  <button
                    type="button"
                    onClick={() => openComposer(column.role)}
                    className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                    aria-label={`Add task to ${column.heading}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </header>

                <div
                  className={cn(
                    "flex-1 space-y-2 overflow-y-auto p-2",
                    draggingTask?.role === column.role && "bg-[rgba(255,255,255,0.02)]",
                  )}
                  onDragOver={(event) => {
                    if (!draggingTask) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggingTask || draggingTask.role === column.role) return;
                    void handleBoardMutation({
                      taskId: draggingTask.taskId,
                      role: column.role,
                    }).catch((err) => {
                      setError(err instanceof Error ? err.message : "Failed to move task");
                    });
                    setDraggingTask(null);
                  }}
                >
                  {column.tasks.length === 0 && (
                    <div className="rounded-[3px] border border-dashed border-[var(--vk-border)] px-2 py-2 text-[13px] text-[var(--vk-text-muted)]">
                      No tasks
                    </div>
                  )}

                  {column.tasks.slice(0, 50).map((task) => {
                    const { title: taskTitle, description: taskDescription } = splitTaskText(task.text);
                    const taskLinkKey = getTaskLinkKey(task);
                    const linkedSessions = projectSessions
                      .filter((session) => session.id === task.attemptRef || session.issueId?.trim() === taskLinkKey)
                      .sort((left, right) => compareProjectSessions(left, right, task.attemptRef ?? null));
                    const primaryLinkedSession = task.attemptRef
                      ? linkedSessions.find((session) => session.id === task.attemptRef) ?? null
                      : (linkedSessions[0] ?? null);
                    const unresolvedPrimaryLink = task.attemptRef
                      && !linkedSessions.some((session) => session.id === task.attemptRef)
                      ? task.attemptRef
                      : null;
                    return (
                      <div
                        key={`${column.role}-${task.id}`}
                        draggable
                        onDragStart={() => setDraggingTask({ taskId: task.id, role: column.role })}
                        onDragEnd={() => setDraggingTask(null)}
                        className={cn(
                          "rounded-[3px] border border-[var(--vk-border)] bg-[color:#212121] p-2",
                          draggingTask?.taskId === task.id && "opacity-60",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 font-mono text-[12px] text-[var(--vk-text-muted)]">
                            {task.taskRef?.trim()
                              || (task.id.length > 12
                                ? `TASK-${task.id.split("-")[0]?.toUpperCase() ?? task.id.toUpperCase()}`
                                : task.id)}
                          </p>
                          <button
                            type="button"
                            onClick={() => openEditor(task, column.role)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
                            aria-label="Edit task"
                            title="Edit task"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="pt-1 text-[15px] leading-[22px] text-[var(--vk-text-normal)]">{taskTitle}</p>
                        {taskDescription && (
                          <p className="pt-1 text-[13px] leading-[20px] text-[var(--vk-text-muted)]">{taskDescription}</p>
                        )}

                        {(linkedSessions.length > 0 || unresolvedPrimaryLink) && (
                          <div className="mt-3 rounded-[4px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                                Runs
                              </span>
                              <span className="text-[11px] text-[var(--vk-text-muted)]">
                                {linkedSessions.length + (unresolvedPrimaryLink ? 1 : 0)}
                              </span>
                            </div>

                            <div className="mt-2 space-y-1.5">
                              {primaryLinkedSession ? (
                                <button
                                  type="button"
                                  onClick={() => router.push(`/sessions/${encodeURIComponent(primaryLinkedSession.id)}?tab=chat`)}
                                  className="flex w-full items-center justify-between gap-2 rounded-[3px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.03)] px-2 py-1.5 text-left hover:bg-[var(--vk-bg-hover)]"
                                  title={primaryLinkedSession.id}
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    {getSessionAgent(primaryLinkedSession) ? (
                                      <AgentTileIcon seed={{ label: getSessionAgent(primaryLinkedSession) as string }} className="h-5 w-5" />
                                    ) : null}
                                    <div className="min-w-0">
                                      <div className="truncate text-[12px] text-[var(--vk-text-normal)]">
                                        {formatLinkedSessionLabel(primaryLinkedSession)}
                                      </div>
                                      <div className="truncate text-[11px] text-[var(--vk-text-muted)]">
                                        Primary run
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <span className={`inline-flex h-5 items-center rounded-[3px] border px-2 text-[10px] ${sessionStatusPillClass(primaryLinkedSession.status)}`}>
                                      {formatSessionStatus(primaryLinkedSession.status)}
                                    </span>
                                    <ExternalLink className="h-3 w-3 text-[var(--vk-text-muted)]" />
                                  </div>
                                </button>
                              ) : null}

                              {linkedSessions
                                .filter((session) => session.id !== primaryLinkedSession?.id)
                                .map((session) => (
                                  <button
                                    key={session.id}
                                    type="button"
                                    onClick={() => router.push(`/sessions/${encodeURIComponent(session.id)}?tab=chat`)}
                                    className="flex w-full items-center justify-between gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-[var(--vk-bg-hover)]"
                                    title={session.id}
                                  >
                                    <div className="flex min-w-0 items-center gap-2">
                                      {getSessionAgent(session) ? (
                                        <AgentTileIcon seed={{ label: getSessionAgent(session) as string }} className="h-5 w-5" />
                                      ) : null}
                                      <span className="truncate text-[12px] text-[var(--vk-text-normal)]">
                                        {formatLinkedSessionLabel(session)}
                                      </span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                      <span className={`inline-flex h-5 items-center rounded-[3px] border px-2 text-[10px] ${sessionStatusPillClass(session.status)}`}>
                                        {formatSessionStatus(session.status)}
                                      </span>
                                      <ExternalLink className="h-3 w-3 text-[var(--vk-text-muted)]" />
                                    </div>
                                  </button>
                                ))}

                              {unresolvedPrimaryLink ? (
                                <button
                                  type="button"
                                  onClick={() => router.push(`/sessions/${encodeURIComponent(unresolvedPrimaryLink)}?tab=chat`)}
                                  className="flex w-full items-center justify-between gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-[var(--vk-bg-hover)]"
                                  title={unresolvedPrimaryLink}
                                >
                                  <div className="min-w-0">
                                    <div className="truncate text-[12px] text-[var(--vk-text-normal)]">{unresolvedPrimaryLink}</div>
                                    <div className="truncate text-[11px] text-[var(--vk-text-muted)]">Primary run</div>
                                  </div>
                                  <ExternalLink className="h-3 w-3 shrink-0 text-[var(--vk-text-muted)]" />
                                </button>
                              ) : null}
                            </div>
                          </div>
                        )}

                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {task.agent ? (
                              <>
                                <AgentTileIcon seed={{ label: task.agent }} className="h-6 w-6" />
                                <span className="truncate text-[12px] text-[var(--vk-text-muted)]">{formatAgentLabel(task.agent)}</span>
                              </>
                            ) : (
                              <span className="text-[12px] text-[var(--vk-text-muted)]">No agent</span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1">
                            {task.type && (
                              <span className="inline-flex h-5 items-center rounded-[3px] bg-[color:#292929] px-2 text-[11px] text-[var(--vk-text-muted)]">
                                {task.type}
                              </span>
                            )}
                            {task.priority && (
                              <span className="inline-flex h-5 items-center rounded-[3px] bg-[color:#292929] px-2 text-[11px] text-[var(--vk-text-muted)]">
                                {task.priority}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {column.tasks.length > 50 && (
                    <div className="rounded-[3px] border border-dashed border-[var(--vk-border)] px-2 py-2 text-center text-[12px] text-[var(--vk-text-muted)]">
                      +{column.tasks.length - 50} more tasks
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {editingTask && (
        <div className="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto bg-black/60 px-3 py-3 sm:items-center sm:py-0" onClick={closeEditor}>
          <div
            className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[560px] flex-col overflow-hidden rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="border-b border-[var(--vk-border)] px-4 py-3">
              <h2 className="text-[18px] text-[var(--vk-text-strong)]">Edit Board Task</h2>
              <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">
                Move the card, update the task, and link the latest session run.
              </p>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Title</span>
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Description</span>
                <textarea
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  rows={3}
                  className="w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Column</span>
                  <select
                    value={editRole}
                    onChange={(event) => setEditRole(toRole(event.target.value))}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  >
                    {board?.columns.map((column) => (
                      <option key={column.role} value={column.role} className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">
                        {column.heading || ROLE_LABEL[column.role]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Agent</span>
                  <select
                    value={editAgent}
                    onChange={(event) => setEditAgent(event.target.value)}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  >
                    {orderedAgentOptions.map((item) => (
                      <option key={item} value={item} className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">
                        {formatAgentLabel(item)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Type</span>
                  <input
                    value={editTaskType}
                    onChange={(event) => setEditTaskType(event.target.value)}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Priority</span>
                  <input
                    value={editPriority}
                    onChange={(event) => setEditPriority(event.target.value)}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Primary linked run</span>
                <select
                  value={editLinkedSession}
                  onChange={(event) => setEditLinkedSession(event.target.value)}
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                >
                  <option value="" className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">No linked session</option>
                  {editLinkedSessionOptions.map((session) => (
                    <option key={session.id} value={session.id} className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">
                      {formatLinkedSessionLabel(session)} · {session.status}
                    </option>
                  ))}
                </select>
              </label>

              {editingError && (
                <p className="text-[12px] text-[var(--vk-red)]">{editingError}</p>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
              <button
                type="button"
                onClick={closeEditor}
                disabled={editingBusy}
                className="inline-flex h-9 items-center rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveEdit()}
                disabled={!editTitle.trim() || editingBusy}
                className="inline-flex h-9 items-center rounded-[3px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                {editingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Task"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {composerOpen && (
        <div className="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto bg-black/60 px-3 py-3 sm:items-center sm:py-0" onClick={() => !submitting && setComposerOpen(false)}>
          <div
            className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[560px] flex-col overflow-hidden rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="border-b border-[var(--vk-border)] px-4 py-3">
              <h2 className="text-[18px] text-[var(--vk-text-strong)]">Create Board Task</h2>
              <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">
                Add a task card with project and agent tags for Obsidian + conductor watcher.
              </p>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Review payment flow regression"
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Description (optional)</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  placeholder="Investigate failing specs and propose a safe fix."
                  className="w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Context notes (optional)</span>
                <textarea
                  value={contextNotes}
                  onChange={(event) => setContextNotes(event.target.value)}
                  rows={2}
                  placeholder="Anything the agent should prioritize or avoid for this task."
                  className="w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Agent</span>
                  <select
                    value={agent}
                    onChange={(event) => setAgent(event.target.value)}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  >
                    {orderedAgentOptions.map((item) => (
                      <option key={item} value={item} className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">
                        {formatAgentLabel(item)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Column</span>
                  <select
                    value={composerRole}
                    onChange={(event) => setComposerRole(toRole(event.target.value))}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  >
                    {visibleColumns.map((column) => (
                      <option key={column.role} value={column.role} className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">
                        {column.heading || ROLE_LABEL[column.role]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Type</span>
                  <input
                    value={taskType}
                    onChange={(event) => setTaskType(event.target.value)}
                    placeholder="feature"
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Priority</span>
                  <input
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    placeholder="normal"
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>
              </div>

              <div className="rounded-[4px] border border-[var(--vk-border)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] text-[var(--vk-text-muted)]">Context attachments</p>
                  <p className="text-[12px] text-[var(--vk-text-muted)]">
                    {selectedContextPaths.length} selected
                    {uploadFiles.length > 0 ? ` · ${uploadFiles.length} upload(s)` : ""}
                  </p>
                </div>

                <div className="mt-2">
                  <label className="inline-flex cursor-pointer items-center rounded-[3px] border border-[var(--vk-border)] px-2 py-1 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]">
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        const next = Array.from(event.target.files ?? []);
                        if (next.length === 0) return;
                        setUploadFiles((current) => {
                          const merged = [...current];
                          for (const file of next) {
                            const exists = merged.some((entry) => (
                              entry.name === file.name
                              && entry.size === file.size
                              && entry.lastModified === file.lastModified
                            ));
                            if (!exists) merged.push(file);
                          }
                          return merged;
                        });
                        event.currentTarget.value = "";
                      }}
                    />
                    Upload files/images
                  </label>
                </div>

                {uploadFiles.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {uploadFiles.map((file) => (
                      <button
                        key={`${file.name}-${file.size}-${file.lastModified}`}
                        type="button"
                        onClick={() => removeUploadFile(file)}
                        className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-hover)] px-2 py-1 text-[11px] text-[var(--vk-text-normal)]"
                        title="Remove upload"
                      >
                        <span className="truncate max-w-[220px]">{file.name}</span>
                        <span className="text-[var(--vk-text-muted)]">×</span>
                      </button>
                    ))}
                  </div>
                )}

                <label className="mt-3 block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">Select existing context</span>
                  <input
                    value={contextSearch}
                    onChange={(event) => setContextSearch(event.target.value)}
                    placeholder="Search context files..."
                    className="h-8 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>

                <div className="mt-2 max-h-[180px] overflow-auto rounded-[3px] border border-[var(--vk-border)]">
                  {contextLoading ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-[var(--vk-text-muted)]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Loading context files...</span>
                    </div>
                  ) : contextError ? (
                    <p className="px-2 py-2 text-[12px] text-[var(--vk-red)]">{contextError}</p>
                  ) : filteredContextFiles.length === 0 ? (
                    <p className="px-2 py-2 text-[12px] text-[var(--vk-text-muted)]">No context files found.</p>
                  ) : (
                    <ul className="divide-y divide-[var(--vk-border)]">
                      {filteredContextFiles.map((file) => {
                        const checked = selectedContextPaths.includes(file.path);
                        return (
                          <li key={file.path} className="px-2 py-1.5">
                            <label className="flex cursor-pointer items-start gap-2 text-[12px] text-[var(--vk-text-normal)]">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleContextPath(file.path)}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--vk-border)] bg-transparent"
                              />
                              <span className="min-w-0">
                                <span className="block truncate">
                                  {file.path}
                                </span>
                                <span className="block text-[11px] text-[var(--vk-text-muted)]">
                                  {file.kind}
                                  {file.source ? ` · ${file.source}` : ""}
                                  {file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ""}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

              {submitError && (
                <p className="text-[12px] text-[var(--vk-red)]">{submitError}</p>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                disabled={submitting}
                className="inline-flex h-9 items-center rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreateTask()}
                disabled={!title.trim() || submitting}
                className="inline-flex h-9 items-center rounded-[3px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create Task"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
