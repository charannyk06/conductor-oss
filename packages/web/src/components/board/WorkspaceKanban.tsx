"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { cn } from "@/lib/cn";

type BoardRole = "intake" | "ready" | "dispatching" | "inProgress" | "review" | "done" | "blocked";

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
  review: "#895af6",
  done: "#21c45d",
  blocked: "#d53946",
};

const ROLE_LABEL: Record<BoardRole, string> = {
  intake: "To do",
  ready: "Ready",
  dispatching: "Dispatching",
  inProgress: "In progress",
  review: "In review",
  done: "Done",
  blocked: "Blocked",
};

function toRole(value: string): BoardRole {
  const roles: BoardRole[] = ["intake", "ready", "dispatching", "inProgress", "review", "done", "blocked"];
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

export function WorkspaceKanban({ projectId, defaultAgent, agentOptions }: WorkspaceKanbanProps) {
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

  const orderedAgentOptions = useMemo(() => {
    const normalized = [...new Set(agentOptions.filter(Boolean))];
    if (!normalized.includes(defaultAgent)) {
      normalized.unshift(defaultAgent);
    }
    return normalized;
  }, [agentOptions, defaultAgent]);

  useEffect(() => {
    if (!orderedAgentOptions.includes(agent)) {
      setAgent(orderedAgentOptions[0] ?? "qwen-code");
    }
  }, [agent, orderedAgentOptions]);

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

  const loadBoard = useCallback(async () => {
    if (!projectId) {
      setBoard(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/boards?projectId=${encodeURIComponent(projectId)}`);
      const data = (await res.json().catch(() => null)) as BoardResponse | { error?: string } | null;
      if (!res.ok) {
        throw new Error((data as { error?: string } | null)?.error ?? `Failed to load board: ${res.status}`);
      }

      setBoard(data as BoardResponse);
      setError(null);
    } catch (err) {
      setBoard(null);
      setError(err instanceof Error ? err.message : "Failed to load board");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const visibleRoles = useMemo(() => {
    const fallback: BoardRole[] = ["intake", "inProgress", "review", "done"];
    const fromPayload = board?.primaryRoles;
    if (!fromPayload || fromPayload.length === 0) return fallback;
    return fromPayload.map((role) => toRole(role));
  }, [board?.primaryRoles]);

  const visibleColumns = useMemo(() => {
    const query = search.trim().toLowerCase();
    const source = board?.columns ?? [];
    const wanted = new Set(visibleRoles);

    return source
      .filter((column) => wanted.has(column.role))
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
  }, [board?.columns, search, visibleRoles]);

  const filteredContextFiles = useMemo(() => {
    const query = contextSearch.trim().toLowerCase();
    if (!query) return contextFiles;
    return contextFiles.filter((file) => {
      const haystack = `${file.path} ${file.name} ${file.source ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [contextFiles, contextSearch]);

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

          <div className="ml-auto flex min-w-[220px] flex-1 items-center gap-2 sm:flex-none">
            <label className="flex h-[31px] min-w-[200px] flex-1 items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 sm:w-[240px] sm:flex-none">
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
              className="inline-flex h-[31px] items-center gap-1 rounded-[3px] bg-[var(--vk-bg-active)] px-3 text-[14px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)]"
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

                <div className="flex-1 space-y-2 overflow-y-auto p-2">
                  {column.tasks.length === 0 && (
                    <div className="rounded-[3px] border border-dashed border-[var(--vk-border)] px-2 py-2 text-[13px] text-[var(--vk-text-muted)]">
                      No tasks
                    </div>
                  )}

                  {column.tasks.map((task) => {
                    const { title: taskTitle, description: taskDescription } = splitTaskText(task.text);
                    return (
                      <div key={`${column.role}-${task.id}`} className="rounded-[3px] border border-[var(--vk-border)] bg-[color:#212121] p-2">
                        <p className="font-mono text-[12px] text-[var(--vk-text-muted)]">{task.taskRef ?? task.id}</p>
                        <p className="pt-1 text-[15px] leading-[22px] text-[var(--vk-text-normal)]">{taskTitle}</p>
                        {taskDescription && (
                          <p className="pt-1 text-[13px] leading-[20px] text-[var(--vk-text-muted)]">{taskDescription}</p>
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
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {composerOpen && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 px-3" onClick={() => !submitting && setComposerOpen(false)}>
          <div
            className="w-full max-w-[560px] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]"
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

            <div className="space-y-3 px-4 py-4">
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

            <footer className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
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
