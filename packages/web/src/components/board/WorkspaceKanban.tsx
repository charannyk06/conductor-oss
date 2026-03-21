"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { usePreferences } from "@/hooks/usePreferences";
import { withBridgeQuery } from "@/lib/bridgeQuery";
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
  issueId: string | null;
  githubItemId: string | null;
  attachments: string[];
  notes: string | null;
  briefPath?: string | null;
  vaultBriefPath?: string | null;
  commentCount: number;
  comments: BoardComment[];
};

type BoardColumn = {
  role: BoardRole;
  heading: string;
  tasks: BoardTask[];
};

type GitHubProjectLink = {
  id?: string | null;
  ownerLogin?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  statusFieldId?: string | null;
  statusFieldName?: string | null;
};

type BoardActivity = {
  id: string;
  source: string;
  action: string;
  detail: string;
  timestamp: string;
};

type BoardComment = {
  id: string;
  taskId: string;
  author: string;
  authorEmail?: string | null;
  provider?: string | null;
  body: string;
  timestamp: string;
};

type WebhookDelivery = {
  id: string;
  event: string;
  action: string;
  status: string;
  detail: string;
  repository?: string | null;
  timestamp: string;
};

type BoardResponse = {
  projectId: string;
  repository?: string | null;
  boardPath: string;
  workspacePath: string;
  columns: BoardColumn[];
  primaryRoles: BoardRole[];
  githubProject?: GitHubProjectLink | null;
  recentActions?: BoardActivity[];
  recentWebhookDeliveries?: WebhookDelivery[];
  createdTaskId?: string;
};

type GitHubProjectsResponse = {
  projectId: string;
  repository?: string | null;
  ownerLogin?: string | null;
  linkedProject?: GitHubProjectLink | null;
  projects: GitHubProjectLink[];
};

type ContextFile = {
  path: string;
  displayPath?: string;
  name: string;
  kind: "image" | "file";
  source?: string;
  sizeBytes?: number | null;
};

type ContextFilesResponse = {
  files: ContextFile[];
};

type ContextTreeNode =
  | {
      kind: "folder";
      name: string;
      path: string;
      children: ContextTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
      file: ContextFile;
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
  bridgeId?: string | null;
  defaultAgent: string;
  agentOptions: string[];
  projectSessions: ProjectSession[];
}

type BoardViewFilter = "active" | "all" | "backlog" | "cancelled";

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
const ACTIVE_BOARD_REFRESH_MS = 20_000;
const HIDDEN_BOARD_REFRESH_MS = 60_000;
const BOARD_REFRESH_DEBOUNCE_MS = 1200;
const MARKDOWN_EDITOR_LABELS: Record<string, string> = {
  obsidian: "Obsidian",
  vscode: "VS Code",
  notion: "Notion",
  typora: "Typora",
  logseq: "Logseq",
  custom: "your editor",
};
const TASK_TYPE_OPTIONS = [
  { value: "feature", label: "Feature" },
  { value: "fix", label: "Fix" },
  { value: "review", label: "Review" },
  { value: "chore", label: "Chore" },
  { value: "docs", label: "Docs" },
] as const;
const PRIORITY_OPTIONS = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;
const MENU_PANEL_CLASS =
  "z-[120] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.35)]";
const MENU_ITEM_CLASS =
  "flex min-h-[40px] cursor-default items-center gap-2 rounded-[4px] px-3 py-2 text-[14px] leading-[21px] text-[var(--vk-text-normal)] outline-none hover:bg-[var(--vk-bg-hover)] focus:bg-[var(--vk-bg-hover)]";

function toRole(value: string): BoardRole {
  const roles: BoardRole[] = [
    "intake",
    "ready",
    "dispatching",
    "inProgress",
    "needsInput",
    "blocked",
    "errored",
    "review",
    "merge",
    "done",
    "cancelled",
  ];
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

function getMarkdownEditorLabel(editorId: string): string {
  return MARKDOWN_EDITOR_LABELS[editorId] ?? "your editor";
}

function getContextOpenLabel(editorId: string): string {
  if (editorId === "obsidian" || editorId === "vscode" || editorId === "typora" || editorId === "logseq") {
    return `Open in ${getMarkdownEditorLabel(editorId)}`;
  }
  return "Open file";
}

function normalizePathSegments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function compareContextNodes(left: ContextTreeNode, right: ContextTreeNode): number {
  if (left.kind !== right.kind) {
    return left.kind === "folder" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function getContextFileDisplayPath(file: ContextFile): string {
  const displayPath = file.displayPath?.trim();
  return displayPath && displayPath.length > 0 ? displayPath : file.path;
}

function buildContextTree(files: ContextFile[]): ContextTreeNode[] {
  const folderChildren = new Map<string, Map<string, ContextTreeNode>>();
  folderChildren.set("", new Map());

  const ensureFolder = (path: string, name: string) => {
    if (!folderChildren.has(path)) {
      folderChildren.set(path, new Map());
    }
    return {
      kind: "folder" as const,
      name,
      path,
      children: [],
    };
  };

  for (const file of files) {
    const displayPath = getContextFileDisplayPath(file);
    const segments = normalizePathSegments(displayPath);
    if (segments.length === 0) {
      continue;
    }

    let parentPath = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const folderPath = parentPath ? `${parentPath}/${segment}` : segment;
      const siblings = folderChildren.get(parentPath) ?? new Map<string, ContextTreeNode>();
      folderChildren.set(parentPath, siblings);
      if (!siblings.has(folderPath)) {
        siblings.set(folderPath, ensureFolder(folderPath, segment));
      }
      if (!folderChildren.has(folderPath)) {
        folderChildren.set(folderPath, new Map());
      }
      parentPath = folderPath;
    }

    const siblings = folderChildren.get(parentPath) ?? new Map<string, ContextTreeNode>();
    siblings.set(file.path, {
      kind: "file",
      name: file.name,
      path: file.path,
      file: {
        ...file,
        displayPath,
      },
    });
    folderChildren.set(parentPath, siblings);
  }

  const buildChildren = (parentPath: string): ContextTreeNode[] =>
    [...(folderChildren.get(parentPath)?.values() ?? [])]
      .map((node) =>
        node.kind === "folder"
          ? { ...node, children: buildChildren(node.path) }
          : node
      )
      .sort(compareContextNodes);

  return buildChildren("");
}

function collectContextFolderPaths(nodes: ContextTreeNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind === "folder") {
      out.add(node.path);
      collectContextFolderPaths(node.children, out);
    }
  }
  return out;
}

function collectContextAncestorFolders(paths: string[]): Set<string> {
  const ancestors = new Set<string>();
  for (const path of paths) {
    const segments = normalizePathSegments(path);
    let current = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      current = current ? `${current}/${segments[index]}` : segments[index]!;
      ancestors.add(current);
    }
  }
  return ancestors;
}

function ContextAttachmentChip({
  attachment,
  onOpen,
  opening = false,
}: {
  attachment: string;
  onOpen: () => void;
  opening?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={opening}
      className="inline-flex max-w-full items-center gap-1 rounded-[3px] bg-[color:#292929] px-2 py-1 text-[11px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] disabled:opacity-60"
      title={attachment}
      aria-label={`Open ${attachment}`}
    >
      {opening ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : (
        <ExternalLink className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{attachment}</span>
    </button>
  );
}

function ContextTreeRow({
  node,
  depth,
  expandedFolders,
  selectedPaths,
  openingContextPath,
  contextOpenLabel,
  onToggleFolder,
  onTogglePath,
  onOpenPath,
}: {
  node: ContextTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  selectedPaths: string[];
  openingContextPath: string | null;
  contextOpenLabel: string;
  onToggleFolder: (path: string) => void;
  onTogglePath: (path: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const paddingLeft = 10 + depth * 16;

  if (node.kind === "folder") {
    const expanded = expandedFolders.has(node.path);
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggleFolder(node.path)}
          className="flex w-full items-center gap-1.5 py-1 text-left text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
          style={{ paddingLeft: `${paddingLeft}px`, paddingRight: "10px" }}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
          )}
          {expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--vk-orange)]" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--vk-orange)]" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded ? (
          <ul>
            {node.children.map((child) => (
              <ContextTreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedPaths={selectedPaths}
                openingContextPath={openingContextPath}
                contextOpenLabel={contextOpenLabel}
                onToggleFolder={onToggleFolder}
                onTogglePath={onTogglePath}
                onOpenPath={onOpenPath}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const checked = selectedPaths.includes(node.path);
  return (
    <li className="border-t border-[var(--vk-border)] first:border-t-0">
      <div
        className="flex items-start gap-2 py-1.5"
        style={{ paddingLeft: `${paddingLeft + 22}px`, paddingRight: "10px" }}
      >
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-[12px] text-[var(--vk-text-normal)]">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onTogglePath(node.path)}
            className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--vk-border)] bg-transparent"
          />
          {node.file.kind === "image" ? (
            <FileImage className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
          ) : (
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
          )}
          <span className="min-w-0">
            <span className="block truncate">{node.name}</span>
            <span className="block truncate text-[11px] text-[var(--vk-text-muted)]">
              {getContextFileDisplayPath(node.file)}
            </span>
            <span className="block text-[11px] text-[var(--vk-text-muted)]">
              {node.file.kind}
              {node.file.source ? ` · ${node.file.source}` : ""}
              {node.file.sizeBytes
                ? ` · ${formatFileSize(node.file.sizeBytes)}`
                : ""}
            </span>
          </span>
        </label>
        <button
          type="button"
          onClick={() => onOpenPath(node.path)}
          disabled={openingContextPath === node.path}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[3px] border border-[var(--vk-border)] px-2 text-[11px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] disabled:opacity-60"
          title={`${contextOpenLabel}: ${node.path}`}
          aria-label={`${contextOpenLabel}: ${node.path}`}
        >
          {openingContextPath === node.path ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ExternalLink className="h-3 w-3" />
          )}
          <span className="hidden sm:inline">{contextOpenLabel}</span>
        </button>
      </div>
    </li>
  );
}

function AgentSelectMenu({
  value,
  options,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className="inline-flex h-10 w-full items-center justify-between rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.14)] px-3 text-left text-[14px] text-[var(--vk-text-normal)] outline-none transition-colors hover:bg-[var(--vk-bg-hover)] data-[state=open]:bg-[var(--vk-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="flex min-w-0 items-center gap-2">
            <AgentTileIcon
              seed={{ label: value }}
              className="h-5 w-5 border-none bg-transparent"
            />
            <span className="truncate">{formatAgentLabel(value)}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--vk-text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={`${MENU_PANEL_CLASS} min-w-[220px] max-w-[calc(100vw-2rem)] max-h-[min(360px,50vh)] overflow-y-auto sm:min-w-[280px]`}
        >
          <p className="px-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
            Agents
          </p>
          {options.map((option) => {
            const selected = option === value;
            return (
              <DropdownMenu.Item
                key={option}
                onSelect={() => onChange(option)}
                className={MENU_ITEM_CLASS}
              >
                <AgentTileIcon
                  seed={{ label: option }}
                  className="h-5 w-5 border-none bg-transparent"
                />
                <span className="min-w-0 flex-1 truncate">
                  {formatAgentLabel(option)}
                </span>
                <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                  {selected ? <Check className="h-4 w-4 text-[var(--vk-orange)]" /> : null}
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function boardsEqual(
  left: BoardResponse | null,
  right: BoardResponse
): boolean {
  if (!left) return false;
  if (
    left.projectId !== right.projectId ||
    left.repository !== right.repository ||
    left.boardPath !== right.boardPath ||
    left.workspacePath !== right.workspacePath ||
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

  for (
    let columnIndex = 0;
    columnIndex < left.columns.length;
    columnIndex += 1
  ) {
    const leftColumn = left.columns[columnIndex];
    const rightColumn = right.columns[columnIndex];
    if (
      leftColumn.role !== rightColumn.role ||
      leftColumn.heading !== rightColumn.heading ||
      leftColumn.tasks.length !== rightColumn.tasks.length
    ) {
      return false;
    }

    for (
      let taskIndex = 0;
      taskIndex < leftColumn.tasks.length;
      taskIndex += 1
    ) {
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
        leftTask.attemptRef !== rightTask.attemptRef ||
        leftTask.issueId !== rightTask.issueId ||
        leftTask.githubItemId !== rightTask.githubItemId ||
        leftTask.notes !== rightTask.notes ||
        leftTask.briefPath !== rightTask.briefPath ||
        leftTask.vaultBriefPath !== rightTask.vaultBriefPath ||
        leftTask.commentCount !== rightTask.commentCount ||
        leftTask.comments.length !== rightTask.comments.length ||
        leftTask.attachments.length !== rightTask.attachments.length
      ) {
        return false;
      }

      for (
        let attachmentIndex = 0;
        attachmentIndex < leftTask.attachments.length;
        attachmentIndex += 1
      ) {
        if (
          leftTask.attachments[attachmentIndex] !==
          rightTask.attachments[attachmentIndex]
        ) {
          return false;
        }
      }

      for (
        let commentIndex = 0;
        commentIndex < leftTask.comments.length;
        commentIndex += 1
      ) {
        if (
          JSON.stringify(leftTask.comments[commentIndex]) !==
          JSON.stringify(rightTask.comments[commentIndex])
        ) {
          return false;
        }
      }
    }
  }

  const leftGitHubProject = left.githubProject ?? null;
  const rightGitHubProject = right.githubProject ?? null;
  if (
    JSON.stringify(leftGitHubProject) !== JSON.stringify(rightGitHubProject)
  ) {
    return false;
  }

  const leftActions = left.recentActions ?? [];
  const rightActions = right.recentActions ?? [];
  if (leftActions.length !== rightActions.length) {
    return false;
  }
  for (let index = 0; index < leftActions.length; index += 1) {
    if (
      JSON.stringify(leftActions[index]) !== JSON.stringify(rightActions[index])
    ) {
      return false;
    }
  }

  const leftDeliveries = left.recentWebhookDeliveries ?? [];
  const rightDeliveries = right.recentWebhookDeliveries ?? [];
  if (leftDeliveries.length !== rightDeliveries.length) {
    return false;
  }
  for (let index = 0; index < leftDeliveries.length; index += 1) {
    if (
      JSON.stringify(leftDeliveries[index]) !==
      JSON.stringify(rightDeliveries[index])
    ) {
      return false;
    }
  }

  return true;
}

function normalizeBoardResponse(value: BoardResponse): BoardResponse {
  return {
    ...value,
    repository: value.repository ?? null,
    githubProject: value.githubProject ?? null,
    recentActions: Array.isArray(value.recentActions)
      ? value.recentActions
      : [],
    recentWebhookDeliveries: Array.isArray(value.recentWebhookDeliveries)
      ? value.recentWebhookDeliveries
      : [],
    columns: Array.isArray(value.columns)
      ? value.columns.map((column) => ({
          ...column,
          tasks: Array.isArray(column.tasks)
            ? column.tasks.map((task) => ({
                ...task,
                issueId: task.issueId ?? null,
                githubItemId: task.githubItemId ?? null,
                attachments: Array.isArray(task.attachments)
                  ? task.attachments
                  : [],
                notes: task.notes ?? null,
                briefPath: task.briefPath ?? null,
                vaultBriefPath: task.vaultBriefPath ?? null,
                commentCount:
                  typeof task.commentCount === "number"
                    ? task.commentCount
                    : Array.isArray(task.comments)
                    ? task.comments.length
                    : 0,
                comments: Array.isArray(task.comments) ? task.comments : [],
              }))
            : [],
        }))
      : [],
  };
}

function formatLinkedSessionLabel(session: ProjectSession): string {
  return (
    session.branch?.trim() || session.summary?.trim() || session.id.slice(0, 8)
  );
}

function getTaskLinkKey(task: BoardTask): string {
  return task.issueId?.trim() || task.taskRef?.trim() || task.id;
}

function sessionMatchesTask(session: ProjectSession, task: BoardTask): boolean {
  if (session.id === task.attemptRef) return true;
  if (session.metadata?.taskId === task.id) return true;
  if (
    task.taskRef?.trim() &&
    session.metadata?.taskRef?.trim() === task.taskRef.trim()
  ) {
    return true;
  }
  return session.issueId?.trim() === getTaskLinkKey(task);
}

function getSessionAgent(session: ProjectSession): string | null {
  const candidate = session.metadata?.agent;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
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

function buildGitHubIssueUrl(
  repository: string | null | undefined,
  issueId: string | null | undefined
): string | null {
  const normalizedIssue = issueId?.trim();
  if (!repository || !normalizedIssue || !/^\d+$/.test(normalizedIssue))
    return null;
  const normalizedRepo = repository
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const [owner, repo] = normalizedRepo.split("/");
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}/issues/${normalizedIssue}`;
}

function formatGitHubProjectLabel(
  project: GitHubProjectLink | null | undefined
): string {
  if (!project?.id) return "No GitHub Project linked";
  const number =
    typeof project.number === "number" ? `#${project.number}` : "Project";
  return `${number} ${project.title?.trim() || "Untitled"}`.trim();
}

function formatActivityTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function formatWebhookStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "synced") return "Synced";
  if (normalized === "failed") return "Failed";
  if (normalized === "skipped") return "Skipped";
  return status;
}

function webhookStatusClass(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "synced") {
    return "border-[rgba(84,176,79,0.35)] bg-[rgba(84,176,79,0.12)] text-[var(--vk-green)]";
  }
  if (normalized === "failed") {
    return "border-[rgba(210,81,81,0.35)] bg-[rgba(210,81,81,0.12)] text-[var(--vk-red)]";
  }
  return "border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] text-[var(--vk-text-muted)]";
}

function findBoardTask(
  board: BoardResponse | null,
  taskId: string
): { task: BoardTask; role: BoardRole } | null {
  if (!board) return null;
  for (const column of board.columns) {
    const task = column.tasks.find((item) => item.id === taskId);
    if (task) {
      return { task, role: column.role };
    }
  }
  return null;
}

function findColumnByRole(
  board: BoardResponse | null,
  role: BoardRole
): BoardColumn | null {
  return board?.columns.find((column) => column.role === role) ?? null;
}

function getDropIndexForColumnEnd(
  board: BoardResponse | null,
  draggingTask: { taskId: string; role: BoardRole } | null,
  role: BoardRole
): number {
  const column = findColumnByRole(board, role);
  if (!column) return 0;

  let count = column.tasks.length;
  if (draggingTask?.role === role) {
    const sourceIndex = column.tasks.findIndex(
      (task) => task.id === draggingTask.taskId
    );
    if (sourceIndex >= 0) {
      count -= 1;
    }
  }

  return Math.max(count, 0);
}

function getDropIndexForTask(
  board: BoardResponse | null,
  draggingTask: { taskId: string; role: BoardRole } | null,
  role: BoardRole,
  taskId: string,
  clientY: number,
  taskElement: HTMLElement
): number {
  const column = findColumnByRole(board, role);
  if (!column) return 0;

  const hoverIndex = column.tasks.findIndex((task) => task.id === taskId);
  if (hoverIndex < 0) {
    return getDropIndexForColumnEnd(board, draggingTask, role);
  }

  const rect = taskElement.getBoundingClientRect();
  const placement = clientY < rect.top + rect.height / 2 ? "before" : "after";
  let nextIndex = hoverIndex + (placement === "after" ? 1 : 0);

  if (draggingTask?.role === role) {
    const sourceIndex = column.tasks.findIndex(
      (task) => task.id === draggingTask.taskId
    );
    if (sourceIndex >= 0 && sourceIndex < nextIndex) {
      nextIndex -= 1;
    }
  }

  return nextIndex;
}

function moveTaskInBoard(
  board: BoardResponse | null,
  taskId: string,
  targetRole: BoardRole,
  targetIndex: number
): BoardResponse | null {
  if (!board) return board;

  const nextColumns = board.columns.map((column) => ({
    ...column,
    tasks: [...column.tasks],
  }));

  let sourceColumnIndex = -1;
  let sourceTaskIndex = -1;
  let taskToMove: BoardTask | null = null;

  for (let columnIndex = 0; columnIndex < nextColumns.length; columnIndex += 1) {
    const taskIndex = nextColumns[columnIndex]?.tasks.findIndex(
      (task) => task.id === taskId
    ) ?? -1;
    if (taskIndex >= 0) {
      sourceColumnIndex = columnIndex;
      sourceTaskIndex = taskIndex;
      taskToMove = nextColumns[columnIndex]!.tasks.splice(taskIndex, 1)[0] ?? null;
      break;
    }
  }

  if (!taskToMove || sourceColumnIndex < 0) {
    return board;
  }

  let targetColumnIndex = nextColumns.findIndex(
    (column) => column.role === targetRole
  );
  if (targetColumnIndex < 0) {
    nextColumns.push({
      role: targetRole,
      heading: ROLE_LABEL[targetRole],
      tasks: [],
    });
    targetColumnIndex = nextColumns.length - 1;
  }

  const targetTasks = nextColumns[targetColumnIndex]!.tasks;
  const insertAt = Math.max(0, Math.min(targetIndex, targetTasks.length));
  targetTasks.splice(insertAt, 0, taskToMove);

  if (
    sourceColumnIndex === targetColumnIndex &&
    sourceTaskIndex === insertAt
  ) {
    return board;
  }

  return {
    ...board,
    columns: nextColumns,
  };
}

function compareProjectSessions(
  left: ProjectSession,
  right: ProjectSession,
  primaryId: string | null
): number {
  if (primaryId) {
    if (left.id === primaryId && right.id !== primaryId) return -1;
    if (right.id === primaryId && left.id !== primaryId) return 1;
  }
  const leftTime = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
  const rightTime = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
  return rightTime - leftTime;
}

export function WorkspaceKanban({
  projectId,
  bridgeId,
  defaultAgent,
  agentOptions,
  projectSessions,
}: WorkspaceKanbanProps) {
  const router = useRouter();
  const { preferences } = usePreferences(bridgeId);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState<BoardViewFilter>("active");

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerRole, setComposerRole] = useState<BoardRole>("intake");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState(defaultAgent);
  const [taskType, setTaskType] = useState("feature");
  const [priority, setPriority] = useState("medium");
  const [contextNotes, setContextNotes] = useState("");
  const [selectedContextPaths, setSelectedContextPaths] = useState<string[]>(
    []
  );
  const [expandedContextFolders, setExpandedContextFolders] = useState<string[]>(
    []
  );
  const [contextSearch, setContextSearch] = useState("");
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [openingContextPath, setOpeningContextPath] = useState<string | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<{
    task: BoardTask;
    role: BoardRole;
  } | null>(null);
  const [editRole, setEditRole] = useState<BoardRole>("intake");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAgent, setEditAgent] = useState(defaultAgent);
  const [editTaskType, setEditTaskType] = useState("feature");
  const [editPriority, setEditPriority] = useState("medium");
  const [editIssueId, setEditIssueId] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editLinkedSession, setEditLinkedSession] = useState("");
  const [editingBusy, setEditingBusy] = useState(false);
  const [editingError, setEditingError] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [draggingTask, setDraggingTask] = useState<{
    taskId: string;
    role: BoardRole;
  } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    role: BoardRole;
    index: number;
  } | null>(null);
  const [projectSyncOpen, setProjectSyncOpen] = useState(false);
  const [projectSyncLoading, setProjectSyncLoading] = useState(false);
  const [projectSyncSaving, setProjectSyncSaving] = useState(false);
  const [projectSyncError, setProjectSyncError] = useState<string | null>(null);
  const [projectSyncData, setProjectSyncData] =
    useState<GitHubProjectsResponse | null>(null);
  const [selectedGitHubProjectId, setSelectedGitHubProjectId] = useState("");
  const hasLoadedBoardRef = useRef(false);
  const boardRequestInFlightRef = useRef(false);
  const boardRefreshTimeoutRef = useRef<number | null>(null);
  const latestBoardRef = useRef<BoardResponse | null>(null);
  const mutationQueueRef = useRef(Promise.resolve<BoardResponse | null>(null));
  const pendingMutationCountRef = useRef(0);
  const preferredMarkdownEditor = preferences?.markdownEditor?.trim() || "obsidian";
  const contextOpenLabel = getContextOpenLabel(preferredMarkdownEditor);
  const [pageVisible, setPageVisible] = useState(true);

  const orderedAgentOptions = useMemo(() => {
    const normalized = [...new Set(agentOptions.filter(Boolean))];
    if (!normalized.includes(defaultAgent)) {
      normalized.unshift(defaultAgent);
    }
    return normalized;
  }, [agentOptions, defaultAgent]);

  useEffect(() => {
    latestBoardRef.current = board;
  }, [board]);

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
    if ((!composerOpen && !editingTask) || !projectId) return;
    let cancelled = false;

    const loadContextFiles = async () => {
      setContextLoading(true);
      setContextError(null);
      try {
        const res = await fetch(
          withBridgeQuery(`/api/context-files?projectId=${encodeURIComponent(projectId)}`, bridgeId)
        );
        const payload = (await res.json().catch(() => null)) as
          | ContextFilesResponse
          | { error?: string }
          | null;
        if (!res.ok) {
          throw new Error(
            (payload as { error?: string } | null)?.error ??
              `Failed to load context files: ${res.status}`
          );
        }
        if (cancelled) return;
        const files = Array.isArray(
          (payload as ContextFilesResponse | null)?.files
        )
          ? (payload as ContextFilesResponse).files
          : [];
        setContextFiles(files);
      } catch (err) {
        if (cancelled) return;
        setContextFiles([]);
        setContextError(
          err instanceof Error ? err.message : "Failed to load context files"
        );
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    };

    void loadContextFiles();
    return () => {
      cancelled = true;
    };
  }, [bridgeId, composerOpen, editingTask, projectId]);

  useEffect(() => {
    hasLoadedBoardRef.current = false;
    setProjectSyncOpen(false);
    setProjectSyncError(null);
    setProjectSyncData(null);
    setSelectedGitHubProjectId("");
  }, [bridgeId, projectId]);

  const loadBoard = useCallback(
    async (options?: { silent?: boolean }) => {
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
      if (options?.silent && pendingMutationCountRef.current > 0) {
        return;
      }

      boardRequestInFlightRef.current = true;

      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const res = await fetch(
          withBridgeQuery(`/api/boards?projectId=${encodeURIComponent(projectId)}`, bridgeId)
        );
        const data = (await res.json().catch(() => null)) as
          | BoardResponse
          | { error?: string }
          | null;
        if (!res.ok) {
          throw new Error(
            (data as { error?: string } | null)?.error ??
              `Failed to load board: ${res.status}`
          );
        }

        const nextBoard = normalizeBoardResponse(data as BoardResponse);
        hasLoadedBoardRef.current = true;
        setBoard((current) =>
          boardsEqual(current, nextBoard) ? current : nextBoard
        );
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
    },
    [bridgeId, projectId]
  );

  const scheduleBoardRefresh = useCallback((options?: { silent?: boolean }) => {
    if (!projectId) {
      return;
    }
    if (boardRefreshTimeoutRef.current !== null) {
      window.clearTimeout(boardRefreshTimeoutRef.current);
      boardRefreshTimeoutRef.current = null;
    }
    boardRefreshTimeoutRef.current = window.setTimeout(() => {
      boardRefreshTimeoutRef.current = null;
      void loadBoard(options);
    }, BOARD_REFRESH_DEBOUNCE_MS);
  }, [loadBoard, projectId]);

  useEffect(() => {
    void loadBoard({ silent: false });
  }, [loadBoard]);

  const loadGitHubProjects = useCallback(async () => {
    if (!projectId) {
      setProjectSyncData(null);
      setProjectSyncError(null);
      return;
    }

    setProjectSyncLoading(true);
    setProjectSyncError(null);
    try {
      const res = await fetch(
        withBridgeQuery(`/api/github/projects?projectId=${encodeURIComponent(projectId)}`, bridgeId)
      );
      const payload = (await res.json().catch(() => null)) as
        | GitHubProjectsResponse
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(
          (payload as { error?: string } | null)?.error ??
            `Failed to load GitHub Projects (${res.status})`
        );
      }

      const next = {
        ...(payload as GitHubProjectsResponse),
        projects: Array.isArray((payload as GitHubProjectsResponse).projects)
          ? (payload as GitHubProjectsResponse).projects
          : [],
      };
      setProjectSyncData(next);
      setSelectedGitHubProjectId(
        next.linkedProject?.id?.trim() || next.projects[0]?.id?.trim() || ""
      );
    } catch (err) {
      setProjectSyncError(
        err instanceof Error ? err.message : "Failed to load GitHub Projects"
      );
      setProjectSyncData(null);
      setSelectedGitHubProjectId("");
    } finally {
      setProjectSyncLoading(false);
    }
  }, [bridgeId, projectId]);

  useEffect(() => {
    if (!projectId) return;

    const refresh = () => {
      if (!pageVisible) {
        return;
      }
      void loadBoard({ silent: true });
    };

    let timeoutId: number | null = null;
    const scheduleRefresh = () => {
      const delay = pageVisible
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
      const visible = document.visibilityState === "visible";
      setPageVisible(visible);
      if (visible) {
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
  }, [loadBoard, pageVisible, projectId]);

  useEffect(() => {
    if (!projectId || !hasLoadedBoardRef.current) return;
    scheduleBoardRefresh({ silent: true });
  }, [projectId, projectSessions, scheduleBoardRefresh]);

  useEffect(() => {
    return () => {
      if (boardRefreshTimeoutRef.current !== null) {
        window.clearTimeout(boardRefreshTimeoutRef.current);
        boardRefreshTimeoutRef.current = null;
      }
    };
  }, [loadBoard, projectId]);

  useEffect(() => {
    if (!projectSyncOpen || !projectId) return;
    void loadGitHubProjects();
  }, [loadGitHubProjects, projectId, projectSyncOpen]);

  const allColumns = board?.columns ?? [];

  const visibleColumns = useMemo(() => {
    const query = search.trim().toLowerCase();
    const allowedRoles =
      viewFilter === "all"
        ? null
        : viewFilter === "backlog"
        ? new Set<BoardRole>(["intake", "ready"])
        : viewFilter === "cancelled"
        ? new Set<BoardRole>(["cancelled"])
        : new Set<BoardRole>([
            "intake",
            "ready",
            "dispatching",
            "inProgress",
            "needsInput",
            "blocked",
            "errored",
            "review",
            "merge",
          ]);

    return allColumns
      .filter((column) => !allowedRoles || allowedRoles.has(column.role))
      .map((column) => {
        if (!query) return column;
        return {
          ...column,
          tasks: column.tasks.filter((task) => {
            const commentText = task.comments
              .map((comment) => `${comment.author} ${comment.body}`)
              .join(" ");
            const haystack = `${task.text} ${task.agent ?? ""} ${
              task.type ?? ""
            } ${task.priority ?? ""} ${task.issueId ?? ""} ${
              task.notes ?? ""
            } ${task.briefPath ?? ""} ${task.attachments.join(" ")} ${commentText}`.toLowerCase();
            return haystack.includes(query);
          }),
        };
      });
  }, [allColumns, search, viewFilter]);
  const dragEnabled = search.trim().length === 0;

  const filteredContextFiles = useMemo(() => {
    const query = contextSearch.trim().toLowerCase();
    const matchingFiles = !query
      ? contextFiles
      : contextFiles.filter((file) => {
          const haystack = `${file.path} ${getContextFileDisplayPath(file)} ${file.name} ${
            file.source ?? ""
          }`.toLowerCase();
          return haystack.includes(query);
        });

    const uniqueFiles = new Map<string, ContextFile>();
    for (const file of matchingFiles) {
      if (!uniqueFiles.has(file.path)) {
        uniqueFiles.set(file.path, file);
      }
    }
    return [...uniqueFiles.values()];
  }, [contextFiles, contextSearch]);
  const filteredContextTree = useMemo(
    () => buildContextTree(filteredContextFiles),
    [filteredContextFiles]
  );
  const contextFilesByPath = useMemo(
    () => new Map(contextFiles.map((file) => [file.path, file])),
    [contextFiles]
  );
  const selectedContextFiles = useMemo(
    () =>
      selectedContextPaths
        .map((path) => contextFilesByPath.get(path))
        .filter((file): file is ContextFile => Boolean(file)),
    [contextFilesByPath, selectedContextPaths]
  );
  const defaultExpandedContextFolders = useMemo(
    () =>
      new Set(
        filteredContextTree
          .filter((node) => node.kind === "folder")
          .map((node) => node.path)
      ),
    [filteredContextTree]
  );
  const autoExpandedContextFolders = useMemo(() => {
    if (contextSearch.trim().length > 0) {
      return collectContextFolderPaths(filteredContextTree);
    }
    return collectContextAncestorFolders(
      selectedContextPaths.map((path) => {
        const file = contextFilesByPath.get(path);
        return file ? getContextFileDisplayPath(file) : path;
      })
    );
  }, [contextFilesByPath, contextSearch, filteredContextTree, selectedContextPaths]);
  const effectiveExpandedContextFolders = useMemo(() => {
    const expanded = new Set(defaultExpandedContextFolders);
    for (const path of expandedContextFolders) {
      expanded.add(path);
    }
    for (const path of autoExpandedContextFolders) {
      expanded.add(path);
    }
    return expanded;
  }, [
    autoExpandedContextFolders,
    defaultExpandedContextFolders,
    expandedContextFolders,
  ]);
  const composerRoleLabel = useMemo(() => {
    const matchingColumn = allColumns.find((column) => column.role === composerRole);
    return matchingColumn?.heading || ROLE_LABEL[composerRole];
  }, [allColumns, composerRole]);
  const editLinkedSessionOptions = useMemo(() => {
    if (!editingTask) return projectSessions;
    const activeTask = findBoardTask(board, editingTask.task.id) ?? editingTask;
    const taskKey = getTaskLinkKey(activeTask.task);
    return [...projectSessions].sort((left, right) => {
      const leftRelated =
        left.id === activeTask.task.attemptRef ||
        left.issueId?.trim() === taskKey;
      const rightRelated =
        right.id === activeTask.task.attemptRef ||
        right.issueId?.trim() === taskKey;
      if (leftRelated !== rightRelated) return leftRelated ? -1 : 1;
      return compareProjectSessions(left, right, activeTask.task.attemptRef);
    });
  }, [board, editingTask, projectSessions]);

  const activeEditingTask = useMemo(() => {
    if (!editingTask) return null;
    return findBoardTask(board, editingTask.task.id) ?? editingTask;
  }, [board, editingTask]);

  function openComposer(role: BoardRole) {
    setComposerRole(role);
    setComposerOpen(true);
    setTitle("");
    setDescription("");
    setAgent(orderedAgentOptions[0] ?? defaultAgent);
    setTaskType("feature");
    setPriority("medium");
    setSubmitError(null);
    setContextNotes("");
    setContextSearch("");
    setSelectedContextPaths([]);
    setExpandedContextFolders([]);
    setUploadFiles([]);
  }

  function clearContextOpenError() {
    if (editingTask) {
      setEditingError(null);
      return;
    }
    if (composerOpen) {
      setSubmitError(null);
      return;
    }
    setError(null);
  }

  function reportContextOpenError(message: string) {
    if (editingTask) {
      setEditingError(message);
      return;
    }
    if (composerOpen) {
      setSubmitError(message);
      return;
    }
    setError(message);
  }

  const openContextAttachment = useCallback(
    async (path: string) => {
      if (!projectId) return;
      setOpeningContextPath(path);
      clearContextOpenError();
      try {
        const response = await fetch("/api/context-files/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, path }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { opened?: boolean; error?: string }
          | null;
        if (!response.ok) {
          throw new Error(
            payload?.error ?? `Failed to open context file: ${response.status}`
          );
        }
      } catch (err) {
        reportContextOpenError(
          err instanceof Error ? err.message : "Failed to open context file"
        );
      } finally {
        setOpeningContextPath((current) =>
          current === path ? null : current
        );
      }
    },
    [composerOpen, editingTask, projectId]
  );

  function toggleContextPath(path: string) {
    setSelectedContextPaths((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    );
  }

  function toggleContextFolder(path: string) {
    setExpandedContextFolders((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    );
  }

  function removeUploadFile(file: File) {
    setUploadFiles((current) =>
      current.filter(
        (entry) =>
          entry.name !== file.name ||
          entry.size !== file.size ||
          entry.lastModified !== file.lastModified
      )
    );
  }

  async function handleCreateTask() {
    if (!projectId || !title.trim()) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch(withBridgeQuery("/api/boards", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: title.trim(),
          description: description.trim() || undefined,
          contextNotes: contextNotes.trim() || undefined,
          attachments:
            selectedContextPaths.length > 0 ? selectedContextPaths : undefined,
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

      if (!res.ok || !payload || !("columns" in payload)) {
        throw new Error(
          (payload as { error?: string } | null)?.error ??
            `Failed to create task: ${res.status}`
        );
      }

      let nextBoard = normalizeBoardResponse(payload as BoardResponse);
      const createdTask = nextBoard.columns
        .flatMap((column) => column.tasks)
        .find((task) => task.id === payload.createdTaskId);

      if (uploadFiles.length > 0 && createdTask) {
        const formData = new FormData();
        formData.append("projectId", projectId);
        formData.append("taskRef", createdTask.taskRef?.trim() || createdTask.id);
        for (const file of uploadFiles) {
          formData.append("files", file);
        }
        const uploadRes = await fetch(withBridgeQuery("/api/attachments", bridgeId), {
          method: "POST",
          body: formData,
        });
        const uploadPayload = (await uploadRes.json().catch(() => null)) as {
          files?: Array<{ path?: string }>;
          error?: string;
        } | null;
        if (!uploadRes.ok) {
          throw new Error(
            uploadPayload?.error ?? `Upload failed: ${uploadRes.status}`
          );
        }

        const uploadedPaths = (uploadPayload?.files ?? [])
          .map((entry) => entry.path?.trim())
          .filter((value): value is string => Boolean(value));

        if (uploadedPaths.length > 0) {
          const patchRes = await fetch(withBridgeQuery("/api/boards", bridgeId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId,
              taskId: createdTask.id,
              attachments: [
                ...new Set([...createdTask.attachments, ...uploadedPaths]),
              ],
            }),
          });
          const patchPayload = (await patchRes.json().catch(() => null)) as
            | BoardResponse
            | { error?: string }
            | null;
          if (!patchRes.ok || !patchPayload || !("columns" in patchPayload)) {
            throw new Error(
              (patchPayload as { error?: string } | null)?.error ??
                `Failed to attach uploads: ${patchRes.status}`
            );
          }
          nextBoard = normalizeBoardResponse(patchPayload as BoardResponse);
        }
      }

      setBoard((current) => ({
        ...(current ?? nextBoard),
        ...nextBoard,
      }));

      setTitle("");
      setDescription("");
      setTaskType("feature");
      setPriority("medium");
      setContextNotes("");
      setSelectedContextPaths([]);
      setContextSearch("");
      setUploadFiles([]);
      setComposerOpen(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create task"
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBoardMutation(
    payload: Record<string, unknown>,
    options?: {
      optimisticUpdate?: (current: BoardResponse) => BoardResponse | null;
    }
  ) {
    if (!projectId) return null;

    const previousBoard = latestBoardRef.current;
    if (previousBoard && options?.optimisticUpdate) {
      const optimisticBoard = options.optimisticUpdate(previousBoard);
      if (optimisticBoard) {
        latestBoardRef.current = optimisticBoard;
        setBoard((current) =>
          boardsEqual(current, optimisticBoard) ? current : optimisticBoard
        );
      }
    }

    pendingMutationCountRef.current += 1;
    const queuedRequest = mutationQueueRef.current
      .catch(() => null)
      .then(async () => {
        const res = await fetch(withBridgeQuery("/api/boards", bridgeId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            ...payload,
          }),
        });
        const data = (await res.json().catch(() => null)) as
          | BoardResponse
          | { error?: string }
          | null;
        if (!res.ok) {
          throw new Error(
            (data as { error?: string } | null)?.error ??
              `Failed to update board: ${res.status}`
          );
        }
        const nextBoard = normalizeBoardResponse(data as BoardResponse);
        latestBoardRef.current = nextBoard;
        setBoard((current) =>
          boardsEqual(current, nextBoard) ? current : nextBoard
        );
        setError(null);
        return nextBoard;
      });

    mutationQueueRef.current = queuedRequest.then(
      () => null,
      () => null
    );

    try {
      return await queuedRequest;
    } catch (err) {
      if (options?.optimisticUpdate && previousBoard) {
        latestBoardRef.current = previousBoard;
        setBoard((current) =>
          boardsEqual(current, previousBoard) ? current : previousBoard
        );
      }
      throw err;
    } finally {
      pendingMutationCountRef.current = Math.max(
        0,
        pendingMutationCountRef.current - 1
      );
    }
  }

  async function handleSaveGitHubProjectLink(link: GitHubProjectLink | null) {
    if (!projectId || projectSyncSaving) return;
    setProjectSyncSaving(true);
    setProjectSyncError(null);
    try {
      const res = await fetch(withBridgeQuery("/api/github/projects", bridgeId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          link: link?.id ? link : null,
        }),
      });
      const payload = (await res.json().catch(() => null)) as {
        githubProject?: GitHubProjectLink | null;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(
          payload?.error ??
            `Failed to update GitHub Project link (${res.status})`
        );
      }

      setBoard((current) =>
        current
          ? { ...current, githubProject: payload?.githubProject ?? null }
          : current
      );
      await loadGitHubProjects();
    } catch (err) {
      setProjectSyncError(
        err instanceof Error
          ? err.message
          : "Failed to update GitHub Project link"
      );
    } finally {
      setProjectSyncSaving(false);
    }
  }

  async function handleGitHubProjectSync(direction: "pull" | "push") {
    if (!projectId || projectSyncSaving) return;
    setProjectSyncSaving(true);
    setProjectSyncError(null);
    try {
      const res = await fetch(withBridgeQuery("/api/github/projects/sync", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, direction }),
      });
      const payload = (await res.json().catch(() => null)) as {
        board?: BoardResponse;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(
          payload?.error ??
            `Failed to ${direction} GitHub Project (${res.status})`
        );
      }
      if (payload?.board) {
        const nextBoard = normalizeBoardResponse(payload.board);
        setBoard((current) =>
          boardsEqual(current, nextBoard) ? current : nextBoard
        );
      } else {
        await loadBoard({ silent: true });
      }
      await loadGitHubProjects();
    } catch (err) {
      setProjectSyncError(
        err instanceof Error
          ? err.message
          : `Failed to ${direction} GitHub Project`
      );
    } finally {
      setProjectSyncSaving(false);
    }
  }

  function openEditor(task: BoardTask, role: BoardRole) {
    const { title: nextTitle, description: nextDescription } = splitTaskText(
      task.text
    );
    setEditingTask({ task, role });
    setEditRole(role);
    setEditTitle(nextTitle);
    setEditDescription(nextDescription);
    setEditAgent(task.agent ?? orderedAgentOptions[0] ?? defaultAgent);
    setEditTaskType(task.type ?? "feature");
    setEditPriority(task.priority ?? "medium");
    setEditIssueId(task.issueId ?? "");
    setEditNotes(task.notes ?? "");
    setEditLinkedSession(task.attemptRef ?? "");
    setEditingError(null);
    setCommentDraft("");
    setCommentError(null);
  }

  function closeEditor() {
    if (editingBusy || commentBusy) return;
    setEditingTask(null);
    setEditingError(null);
    setCommentDraft("");
    setCommentError(null);
  }

  async function handleSaveEdit() {
    if (!activeEditingTask || !editTitle.trim()) return;
    setEditingBusy(true);
    setEditingError(null);
    try {
      await handleBoardMutation({
        taskId: activeEditingTask.task.id,
        role: editRole,
        title: editTitle.trim(),
        description: editDescription,
        contextNotes: editNotes.trim() || "",
        issueId: editIssueId.trim() || "",
        agent: editAgent,
        type: editTaskType,
        priority: editPriority,
        attemptRef: editLinkedSession,
        taskRef: editLinkedSession
          ? activeEditingTask.task.taskRef ?? activeEditingTask.task.id
          : activeEditingTask.task.taskRef ?? "",
      });
      setEditingTask(null);
    } catch (err) {
      setEditingError(
        err instanceof Error ? err.message : "Failed to update task"
      );
    } finally {
      setEditingBusy(false);
    }
  }

  async function handleAddComment() {
    if (!projectId || !activeEditingTask || !commentDraft.trim()) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      const res = await fetch(withBridgeQuery("/api/boards/comments", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          taskId: activeEditingTask.task.id,
          body: commentDraft.trim(),
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | BoardResponse
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(
          (payload as { error?: string } | null)?.error ??
            `Failed to add comment: ${res.status}`
        );
      }
      const nextBoard = normalizeBoardResponse(payload as BoardResponse);
      setBoard((current) =>
        boardsEqual(current, nextBoard) ? current : nextBoard
      );
      setCommentDraft("");
    } catch (err) {
      setCommentError(
        err instanceof Error ? err.message : "Failed to add comment"
      );
    } finally {
      setCommentBusy(false);
    }
  }

  function handleTaskDragStart(taskId: string, role: BoardRole) {
    setDraggingTask({ taskId, role });
    const endIndex = getDropIndexForColumnEnd(latestBoardRef.current, { taskId, role }, role);
    setDropIndicator({ role, index: endIndex });
  }

  function handleColumnDragOver(
    event: DragEvent<HTMLDivElement>,
    role: BoardRole
  ) {
    if (!draggingTask) return;
    event.preventDefault();
    if (event.target !== event.currentTarget) return;
    const endIndex = getDropIndexForColumnEnd(latestBoardRef.current, draggingTask, role);
    setDropIndicator((current) =>
      current?.role === role && current.index === endIndex
        ? current
        : { role, index: endIndex }
    );
  }

  function handleTaskDragOver(
    event: DragEvent<HTMLDivElement>,
    role: BoardRole,
    taskId: string
  ) {
    if (!draggingTask) return;
    event.preventDefault();
    const nextIndex = getDropIndexForTask(
      latestBoardRef.current,
      draggingTask,
      role,
      taskId,
      event.clientY,
      event.currentTarget
    );
    setDropIndicator((current) =>
      current?.role === role && current.index === nextIndex
        ? current
        : { role, index: nextIndex }
    );
  }

  async function handleColumnDrop(role: BoardRole) {
    if (!draggingTask) return;
    const sourceColumn = findColumnByRole(latestBoardRef.current, draggingTask.role);
    const sourceIndex =
      sourceColumn?.tasks.findIndex((task) => task.id === draggingTask.taskId) ?? -1;
    const fallbackIndex = getDropIndexForColumnEnd(
      latestBoardRef.current,
      draggingTask,
      role
    );
    const targetIndex =
      dropIndicator?.role === role ? dropIndicator.index : fallbackIndex;
    const moveTargetChanged =
      draggingTask.role !== role ||
      targetIndex !== sourceIndex;

    try {
      if (moveTargetChanged) {
        await handleBoardMutation(
          {
            taskId: draggingTask.taskId,
            role,
            targetIndex,
          },
          {
            optimisticUpdate: (current) =>
              moveTaskInBoard(current, draggingTask.taskId, role, targetIndex),
          }
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move task");
    } finally {
      setDraggingTask(null);
      setDropIndicator(null);
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
            {(
              [
                ["active", "Active"],
                ["all", "All"],
                ["backlog", "Backlog"],
                ["cancelled", "Cancelled"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setViewFilter(value)}
                className={cn(
                  "px-3 py-1 text-[13px]",
                  viewFilter === value
                    ? "rounded-[2px] bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                    : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:min-w-[220px] sm:flex-nowrap sm:flex-none">
            <label className="flex h-[38px] min-w-0 flex-1 items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 sm:h-[31px] sm:min-w-[200px] sm:w-[240px] sm:flex-none">
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
              className="inline-flex h-[38px] w-full items-center justify-center gap-1 rounded-[3px] bg-[var(--vk-bg-active)] px-3 text-[14px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] sm:h-[31px] sm:w-auto"
            >
              <span>New Issue</span>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setProjectSyncOpen((current) => !current)}
            className="inline-flex h-[38px] items-center gap-2 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] sm:h-[31px]"
          >
            <span className="hidden sm:inline">GitHub Project</span>
            <span className="sm:hidden">GitHub</span>
            <span className="text-[var(--vk-text-muted)]">
              {board?.githubProject?.id
                ? formatGitHubProjectLabel(board.githubProject)
                : "Connect"}
            </span>
          </button>

          {board?.githubProject?.url ? (
            <a
              href={board.githubProject.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-[38px] items-center gap-1 rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] sm:h-[31px]"
            >
              <span>Open Project</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>

        {!dragEnabled && (
          <p className="pt-2 text-[12px] text-[var(--vk-text-muted)]">
            Clear search to reorder cards.
          </p>
        )}

        {projectSyncOpen && (
          <div className="mt-3 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                  Linked project
                </span>
                <select
                  value={selectedGitHubProjectId}
                  onChange={(event) =>
                    setSelectedGitHubProjectId(event.target.value)
                  }
                  disabled={projectSyncLoading || projectSyncSaving}
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                >
                  <option value="">
                    {projectSyncLoading
                      ? "Loading GitHub Projects..."
                      : "Select a GitHub Project"}
                  </option>
                  {(projectSyncData?.projects ?? []).map((project) => (
                    <option
                      key={project.id ?? "unknown"}
                      value={project.id ?? ""}
                    >
                      {formatGitHubProjectLabel(project)}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                disabled={
                  !selectedGitHubProjectId ||
                  projectSyncLoading ||
                  projectSyncSaving
                }
                onClick={() => {
                  const project =
                    projectSyncData?.projects.find(
                      (item) => item.id === selectedGitHubProjectId
                    ) ?? null;
                  void handleSaveGitHubProjectLink(project);
                }}
                className="inline-flex h-9 items-center rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                {projectSyncSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Connect"
                )}
              </button>

              <button
                type="button"
                disabled={!board?.githubProject?.id || projectSyncSaving}
                onClick={() => void handleSaveGitHubProjectLink(null)}
                className="inline-flex h-9 items-center rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                Disconnect
              </button>

              <button
                type="button"
                disabled={!board?.githubProject?.id || projectSyncSaving}
                onClick={() => void handleGitHubProjectSync("pull")}
                className="inline-flex h-9 items-center gap-2 rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                {projectSyncSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Pull
              </button>

              <button
                type="button"
                disabled={!board?.githubProject?.id || projectSyncSaving}
                onClick={() => void handleGitHubProjectSync("push")}
                className="inline-flex h-9 items-center rounded-[3px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
              >
                Push
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-[var(--vk-text-muted)]">
              <span>
                Repository:{" "}
                {board?.repository?.trim() ||
                  projectSyncData?.repository?.trim() ||
                  "Not configured"}
              </span>
              {projectSyncData?.ownerLogin ? (
                <span>Owner: {projectSyncData.ownerLogin}</span>
              ) : null}
            </div>

            {projectSyncError && (
              <p className="mt-2 text-[12px] text-[var(--vk-red)]">
                {projectSyncError}
              </p>
            )}

            {(board?.recentWebhookDeliveries?.length ?? 0) > 0 && (
              <div className="mt-3 rounded-[6px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-[12px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                    Webhook diagnostics
                  </h3>
                  <span className="text-[11px] text-[var(--vk-text-muted)]">
                    {(board?.recentWebhookDeliveries ?? []).length}
                  </span>
                </div>

                <div className="space-y-2">
                  {(board?.recentWebhookDeliveries ?? [])
                    .slice(0, 6)
                    .map((delivery) => (
                      <div
                        key={delivery.id}
                        className="rounded-[4px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex h-5 items-center rounded-[3px] border px-2 text-[10px] ${webhookStatusClass(
                              delivery.status
                            )}`}
                          >
                            {formatWebhookStatus(delivery.status)}
                          </span>
                          <span className="text-[12px] text-[var(--vk-text-normal)]">
                            {delivery.event}
                            {delivery.action ? ` / ${delivery.action}` : ""}
                          </span>
                          <span className="ml-auto text-[11px] text-[var(--vk-text-muted)]">
                            {formatActivityTime(delivery.timestamp)}
                          </span>
                        </div>
                        <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                          {delivery.detail}
                        </p>
                        {delivery.repository ? (
                          <p className="mt-1 text-[11px] text-[var(--vk-text-muted)]">
                            Repo: {delivery.repository}
                          </p>
                        ) : null}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(board?.recentActions?.length ?? 0) > 0 && (
          <div className="mt-3 rounded-[6px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[12px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                Recent activity
              </h3>
              <span className="text-[11px] text-[var(--vk-text-muted)]">
                {(board?.recentActions ?? []).length}
              </span>
            </div>

            <div className="space-y-2">
              {(board?.recentActions ?? []).slice(0, 6).map((activity) => (
                <div
                  key={activity.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
                >
                  <span className="rounded-[3px] bg-[color:#292929] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                    {activity.source}
                  </span>
                  <span className="text-[var(--vk-text-normal)]">
                    {activity.action}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[var(--vk-text-muted)]"
                    title={activity.detail}
                  >
                    {activity.detail}
                  </span>
                  <span className="text-[11px] text-[var(--vk-text-muted)]">
                    {formatActivityTime(activity.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
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
            className="flex min-h-full min-w-0 snap-x snap-mandatory items-start gap-3 overflow-x-auto pb-3 sm:snap-none"
          >
            {visibleColumns.map((column) => {
              const fullColumn = allColumns.find(
                (candidate) => candidate.role === column.role
              );
              const sourceIndex =
                dragEnabled && draggingTask?.role === column.role
                  ? fullColumn?.tasks.findIndex(
                      (task) => task.id === draggingTask.taskId
                    ) ?? -1
                  : -1;
              const fullTaskCount = fullColumn?.tasks.length ?? column.tasks.length;
              const effectiveTaskCount = Math.max(
                fullTaskCount - (sourceIndex >= 0 ? 1 : 0),
                0
              );

              return (
              <article
                key={column.role}
                className={cn(
                  "flex min-h-[560px] w-[85vw] shrink-0 snap-center flex-col rounded-[14px] border border-[var(--vk-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] shadow-[0_18px_40px_rgba(0,0,0,0.24)] sm:w-[320px] sm:snap-align-none",
                  draggingTask && "snap-start"
                )}
              >
                <header className="flex items-center gap-2 border-b border-[var(--vk-border)] px-3 py-3">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ROLE_COLOR[column.role] }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-[var(--vk-text-normal)]">
                      {column.heading || ROLE_LABEL[column.role]}
                    </p>
                  </div>
                  <span className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(0,0,0,0.18)] px-2 text-[11px] text-[var(--vk-text-muted)]">
                    {column.tasks.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => openComposer(column.role)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-[7px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] sm:h-7 sm:w-7"
                    aria-label={`Add task to ${column.heading}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </header>

                <div
                  className={cn(
                    "flex-1 overflow-y-auto px-3 pb-3 pt-2",
                    draggingTask?.role === column.role &&
                      "bg-[rgba(255,255,255,0.02)]"
                  )}
                  onDragOver={(event) =>
                    dragEnabled ? handleColumnDragOver(event, column.role) : undefined
                  }
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!dragEnabled) return;
                    void handleColumnDrop(column.role);
                  }}
                >
                  {dragEnabled &&
                  dropIndicator?.role === column.role &&
                  dropIndicator.index === 0 ? (
                    <div className="mb-2 h-[3px] rounded-full bg-[var(--vk-orange)] shadow-[0_0_0_1px_rgba(0,0,0,0.2)]" />
                  ) : null}

                  {column.tasks.length === 0 && (
                    <div className="rounded-[10px] border border-dashed border-[var(--vk-border)] px-3 py-4 text-[13px] text-[var(--vk-text-muted)]">
                      Drop a card here or create a new one.
                    </div>
                  )}

                  <div className="space-y-2">
                  {column.tasks.map((task) => {
                    const { title: taskTitle, description: taskDescription } =
                      splitTaskText(task.text);
                    const fullTaskIndex =
                      fullColumn?.tasks.findIndex((item) => item.id === task.id) ??
                      0;
                    const effectiveTaskIndex =
                      sourceIndex >= 0
                        ? task.id === draggingTask?.taskId
                          ? null
                          : fullTaskIndex > sourceIndex
                          ? fullTaskIndex - 1
                          : fullTaskIndex
                        : fullTaskIndex;
                    const taskLinkKey = getTaskLinkKey(task);
                    const issueUrl = buildGitHubIssueUrl(
                      board?.repository,
                      task.issueId
                    );
                    const linkedSessions = projectSessions
                      .filter((session) => sessionMatchesTask(session, task))
                      .sort((left, right) =>
                        compareProjectSessions(
                          left,
                          right,
                          task.attemptRef ?? null
                        )
                      );
                    const primaryLinkedSession = task.attemptRef
                      ? linkedSessions.find(
                          (session) => session.id === task.attemptRef
                        ) ?? null
                      : linkedSessions[0] ?? null;
                    const unresolvedPrimaryLink =
                      task.attemptRef &&
                      !linkedSessions.some(
                        (session) => session.id === task.attemptRef
                      )
                        ? task.attemptRef
                        : null;
                    return (
                      <div key={`${column.role}-${task.id}`}>
                        {dragEnabled &&
                        dropIndicator?.role === column.role &&
                        effectiveTaskIndex !== null &&
                        dropIndicator.index === effectiveTaskIndex ? (
                          <div className="mb-2 h-[3px] rounded-full bg-[var(--vk-orange)] shadow-[0_0_0_1px_rgba(0,0,0,0.2)]" />
                        ) : null}
                        <div
                          draggable={dragEnabled}
                          onDragStart={() =>
                            dragEnabled
                              ? handleTaskDragStart(task.id, column.role)
                              : undefined
                          }
                          onDragOver={(event) =>
                            dragEnabled
                              ? handleTaskDragOver(event, column.role, task.id)
                              : undefined
                          }
                          onDragEnd={() => {
                            setDraggingTask(null);
                            setDropIndicator(null);
                          }}
                          className={cn(
                            "rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-[rgba(23,25,30,0.96)] p-3 shadow-[0_10px_24px_rgba(0,0,0,0.24)] [content-visibility:auto] [contain-intrinsic-size:240px]",
                            draggingTask?.taskId === task.id && "opacity-60"
                          )}
                        >
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 font-mono text-[12px] text-[var(--vk-text-muted)]">
                            {task.taskRef?.trim() ||
                              (task.id.length > 12
                                ? `TASK-${
                                    task.id.split("-")[0]?.toUpperCase() ??
                                    task.id.toUpperCase()
                                  }`
                                : task.id)}
                          </p>
                          <button
                            type="button"
                            onClick={() => openEditor(task, column.role)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] sm:h-6 sm:w-6"
                            aria-label="Edit task"
                            title="Edit task"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="pt-1 text-[15px] leading-[22px] text-[var(--vk-text-normal)]">
                          {taskTitle}
                        </p>
                        {taskDescription && (
                          <p className="pt-1 text-[13px] leading-[20px] text-[var(--vk-text-muted)]">
                            {taskDescription}
                          </p>
                        )}
                        {task.notes && (
                          <p className="pt-2 text-[12px] leading-[18px] text-[var(--vk-text-muted)]">
                            {task.notes}
                          </p>
                        )}

                        {task.commentCount > 0 && (
                          <div className="mt-2 flex items-center gap-1 text-[11px] text-[var(--vk-text-muted)]">
                            <MessageSquare className="h-3.5 w-3.5" />
                            <span>
                              {task.commentCount} comment
                              {task.commentCount === 1 ? "" : "s"}
                            </span>
                          </div>
                        )}

                        {(task.issueId ||
                          task.briefPath ||
                          task.attachments.length > 0) && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {task.issueId ? (
                              issueUrl ? (
                                <a
                                  href={issueUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex h-5 items-center gap-1 rounded-[3px] border border-[var(--vk-border)] px-2 text-[11px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                                >
                                  <span>Issue #{task.issueId}</span>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                <span className="inline-flex h-5 items-center rounded-[3px] border border-[var(--vk-border)] px-2 text-[11px] text-[var(--vk-text-muted)]">
                                  Issue {task.issueId}
                                </span>
                              )
                            ) : null}

                            {task.briefPath ? (
                              <ContextAttachmentChip
                                attachment={task.briefPath}
                                opening={openingContextPath === task.briefPath}
                                onOpen={() =>
                                  void openContextAttachment(task.briefPath as string)
                                }
                              />
                            ) : null}

                            {task.attachments.map((attachment) => (
                              <ContextAttachmentChip
                                key={`${task.id}-${attachment}`}
                                attachment={attachment}
                                opening={openingContextPath === attachment}
                                onOpen={() => void openContextAttachment(attachment)}
                              />
                            ))}
                          </div>
                        )}

                        {(linkedSessions.length > 0 ||
                          unresolvedPrimaryLink) && (
                          <div className="mt-3 rounded-[4px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                                Runs
                              </span>
                              <span className="text-[11px] text-[var(--vk-text-muted)]">
                                {linkedSessions.length +
                                  (unresolvedPrimaryLink ? 1 : 0)}
                              </span>
                            </div>

                            <div className="mt-2 space-y-1.5">
                              {primaryLinkedSession ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    router.push(
                                      `/sessions/${encodeURIComponent(
                                        primaryLinkedSession.id
                                      )}`
                                    )
                                  }
                                  className="flex w-full items-center justify-between gap-2 rounded-[3px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.03)] px-2 py-1.5 text-left hover:bg-[var(--vk-bg-hover)]"
                                  title={primaryLinkedSession.id}
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    {getSessionAgent(primaryLinkedSession) ? (
                                      <AgentTileIcon
                                        seed={{
                                          label: getSessionAgent(
                                            primaryLinkedSession
                                          ) as string,
                                        }}
                                        className="h-5 w-5"
                                      />
                                    ) : null}
                                    <div className="min-w-0">
                                      <div className="truncate text-[12px] text-[var(--vk-text-normal)]">
                                        {formatLinkedSessionLabel(
                                          primaryLinkedSession
                                        )}
                                      </div>
                                      <div className="truncate text-[11px] text-[var(--vk-text-muted)]">
                                        Primary run
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <span
                                      className={`inline-flex h-5 items-center rounded-[3px] border px-2 text-[10px] ${sessionStatusPillClass(
                                        primaryLinkedSession.status
                                      )}`}
                                    >
                                      {formatSessionStatus(
                                        primaryLinkedSession.status
                                      )}
                                    </span>
                                    <ExternalLink className="h-3 w-3 text-[var(--vk-text-muted)]" />
                                  </div>
                                </button>
                              ) : null}

                              {linkedSessions
                                .filter(
                                  (session) =>
                                    session.id !== primaryLinkedSession?.id
                                )
                                .map((session) => (
                                  <button
                                    key={session.id}
                                    type="button"
                                    onClick={() =>
                                      router.push(
                                        `/sessions/${encodeURIComponent(
                                          session.id
                                        )}`
                                      )
                                    }
                                    className="flex w-full items-center justify-between gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-[var(--vk-bg-hover)]"
                                    title={session.id}
                                  >
                                    <div className="flex min-w-0 items-center gap-2">
                                      {getSessionAgent(session) ? (
                                        <AgentTileIcon
                                          seed={{
                                            label: getSessionAgent(
                                              session
                                            ) as string,
                                          }}
                                          className="h-5 w-5"
                                        />
                                      ) : null}
                                      <span className="truncate text-[12px] text-[var(--vk-text-normal)]">
                                        {formatLinkedSessionLabel(session)}
                                      </span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                      <span
                                        className={`inline-flex h-5 items-center rounded-[3px] border px-2 text-[10px] ${sessionStatusPillClass(
                                          session.status
                                        )}`}
                                      >
                                        {formatSessionStatus(session.status)}
                                      </span>
                                      <ExternalLink className="h-3 w-3 text-[var(--vk-text-muted)]" />
                                    </div>
                                  </button>
                                ))}

                              {unresolvedPrimaryLink ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    router.push(
                                      `/sessions/${encodeURIComponent(
                                        unresolvedPrimaryLink
                                      )}`
                                    )
                                  }
                                  className="flex w-full items-center justify-between gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-[var(--vk-bg-hover)]"
                                  title={unresolvedPrimaryLink}
                                >
                                  <div className="min-w-0">
                                    <div className="truncate text-[12px] text-[var(--vk-text-normal)]">
                                      {unresolvedPrimaryLink}
                                    </div>
                                    <div className="truncate text-[11px] text-[var(--vk-text-muted)]">
                                      Primary run
                                    </div>
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
                                <AgentTileIcon
                                  seed={{ label: task.agent }}
                                  className="h-6 w-6"
                                />
                                <span className="truncate text-[12px] text-[var(--vk-text-muted)]">
                                  {formatAgentLabel(task.agent)}
                                </span>
                              </>
                            ) : (
                              <span className="text-[12px] text-[var(--vk-text-muted)]">
                                No agent
                              </span>
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
                      </div>
                    );
                  })}
                  </div>

                  {dragEnabled &&
                  dropIndicator?.role === column.role &&
                  dropIndicator.index === effectiveTaskCount ? (
                    <div className="mt-2 h-[3px] rounded-full bg-[var(--vk-orange)] shadow-[0_0_0_1px_rgba(0,0,0,0.2)]" />
                  ) : null}
                </div>
              </article>
            );
            })}
          </div>
        )}
      </div>

      {activeEditingTask && (
        <div
          className="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto bg-black/60 px-3 py-3 sm:items-center sm:py-0"
          onClick={closeEditor}
        >
          <div
            className="flex max-h-[100dvh] w-full flex-col overflow-hidden border-[var(--vk-border)] bg-[var(--vk-bg-panel)] sm:max-h-[calc(100dvh-1.5rem)] sm:max-w-[560px] sm:rounded-[6px] sm:border"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="border-b border-[var(--vk-border)] px-4 py-3">
              <h2 className="text-[18px] text-[var(--vk-text-strong)]">
                Edit Board Task
              </h2>
              <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">
                Move the card, update the task, and link the latest session run.
              </p>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                  Title
                </span>
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                  Description
                </span>
                <textarea
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  rows={3}
                  className="w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                    Column
                  </span>
                  <select
                    value={editRole}
                    onChange={(event) =>
                      setEditRole(toRole(event.target.value))
                    }
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  >
                    {board?.columns.map((column) => (
                      <option
                        key={column.role}
                        value={column.role}
                        className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]"
                      >
                        {column.heading || ROLE_LABEL[column.role]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                    Agent
                  </span>
                  <AgentSelectMenu
                    value={editAgent}
                    options={orderedAgentOptions}
                    disabled={editingBusy}
                    onChange={setEditAgent}
                    ariaLabel="Select agent for task"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                    Type
                  </span>
                  <input
                    value={editTaskType}
                    onChange={(event) => setEditTaskType(event.target.value)}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                    Priority
                  </span>
                  <input
                    value={editPriority}
                    onChange={(event) => setEditPriority(event.target.value)}
                    className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                  GitHub issue id (optional)
                </span>
                <input
                  value={editIssueId}
                  onChange={(event) => setEditIssueId(event.target.value)}
                  placeholder="123"
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                  Notes
                </span>
                <textarea
                  value={editNotes}
                  onChange={(event) => setEditNotes(event.target.value)}
                  rows={3}
                  className="w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>

              {activeEditingTask.task.attachments.length > 0 && (
                <div>
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                    Attachments
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {activeEditingTask.task.attachments.map((attachment) => (
                      <ContextAttachmentChip
                        key={attachment}
                        attachment={attachment}
                        opening={openingContextPath === attachment}
                        onOpen={() => void openContextAttachment(attachment)}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-[4px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[12px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                    Comments
                  </span>
                  <span className="text-[11px] text-[var(--vk-text-muted)]">
                    {activeEditingTask.task.commentCount}
                  </span>
                </div>

                <div className="space-y-2">
                  {activeEditingTask.task.comments.length > 0 ? (
                    activeEditingTask.task.comments.map((comment) => (
                      <div
                        key={comment.id}
                        className="rounded-[4px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] text-[var(--vk-text-normal)]">
                            {comment.author}
                          </span>
                          <span className="text-[11px] text-[var(--vk-text-muted)]">
                            {formatActivityTime(comment.timestamp)}
                          </span>
                        </div>
                        <p className="pt-1 whitespace-pre-wrap text-[13px] leading-[20px] text-[var(--vk-text-muted)]">
                          {comment.body}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-[12px] text-[var(--vk-text-muted)]">
                      No comments yet.
                    </p>
                  )}
                </div>

                <label className="mt-3 block">
                  <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                    Add comment
                  </span>
                  <textarea
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    rows={3}
                    placeholder="Share status, request input, or leave implementation notes."
                    className="w-full rounded-[3px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                </label>

                {commentError && (
                  <p className="mt-2 text-[12px] text-[var(--vk-red)]">
                    {commentError}
                  </p>
                )}

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void handleAddComment()}
                    disabled={!commentDraft.trim() || commentBusy}
                    className="inline-flex h-9 items-center gap-2 rounded-[3px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    {commentBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MessageSquare className="h-4 w-4" />
                    )}
                    Post comment
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-[12px] text-[var(--vk-text-muted)]">
                  Primary linked run
                </span>
                <select
                  value={editLinkedSession}
                  onChange={(event) => setEditLinkedSession(event.target.value)}
                  className="h-9 w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                >
                  <option
                    value=""
                    className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]"
                  >
                    No linked session
                  </option>
                  {editLinkedSessionOptions.map((session) => (
                    <option
                      key={session.id}
                      value={session.id}
                      className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]"
                    >
                      {formatLinkedSessionLabel(session)} · {session.status}
                    </option>
                  ))}
                </select>
              </label>

              {editingError && (
                <p className="text-[12px] text-[var(--vk-red)]">
                  {editingError}
                </p>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
              <button
                type="button"
                onClick={closeEditor}
                disabled={editingBusy || commentBusy}
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
                {editingBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Save Task"
                )}
              </button>
            </footer>
          </div>
        </div>
      )}

      {composerOpen && (
        <div
          className="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto bg-black/60 px-3 py-3 sm:items-center sm:py-0"
          onClick={() => !submitting && setComposerOpen(false)}
        >
          <div
            className="flex max-h-[100dvh] w-full flex-col overflow-hidden border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_28px_80px_rgba(0,0,0,0.45)] sm:max-h-[calc(100dvh-1.5rem)] sm:max-w-[980px] sm:rounded-[10px] sm:border"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="border-b border-[var(--vk-border)] px-4 py-4 sm:px-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h2 className="text-[20px] font-medium text-[var(--vk-text-strong)]">
                    Create Board Task
                  </h2>
                  <p className="pt-1 text-[13px] leading-5 text-[var(--vk-text-muted)]">
                    Capture the task, route it to the right board column, and
                    attach the notes or files the agent should treat as source
                    of truth.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className="rounded-full border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[var(--vk-text-normal)]">
                    Column · {composerRoleLabel}
                  </span>
                  <span className="rounded-full border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[var(--vk-text-normal)]">
                    Agent · {formatAgentLabel(agent)}
                  </span>
                  <span className="rounded-full border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[var(--vk-text-normal)]">
                    {selectedContextPaths.length + uploadFiles.length} attachment
                    {selectedContextPaths.length + uploadFiles.length === 1
                      ? ""
                      : "s"}
                  </span>
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(290px,0.95fr)]">
                <div className="space-y-4">
                  <section className="rounded-[8px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-4">
                    <div className="mb-3">
                      <h3 className="text-[15px] font-medium text-[var(--vk-text-strong)]">
                        Task brief
                      </h3>
                      <p className="pt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                        Write the task the way you want it to appear on the board
                        and in the agent prompt.
                      </p>
                    </div>

                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                        Title
                      </span>
                      <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Review payment flow regression"
                        className="h-11 w-full rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.14)] px-3 text-[15px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                      />
                      <p className="mt-1.5 text-[11px] text-[var(--vk-text-muted)]">
                        Keep it short and outcome-focused so the card stays scannable.
                      </p>
                    </label>

                    <label className="mt-4 block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                        Description
                      </span>
                      <textarea
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        rows={5}
                        placeholder="Investigate failing specs, confirm the root cause, and propose a safe fix."
                        className="w-full rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.14)] px-3 py-2.5 text-[14px] leading-6 text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                      />
                    </label>

                    <label className="mt-4 block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                        Context notes
                      </span>
                      <textarea
                        value={contextNotes}
                        onChange={(event) => setContextNotes(event.target.value)}
                        rows={4}
                        placeholder="Add constraints, pitfalls, or review expectations the agent should keep in mind."
                        className="w-full rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.14)] px-3 py-2.5 text-[14px] leading-6 text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                      />
                    </label>
                  </section>
                </div>

                <div className="space-y-4">
                  <section className="rounded-[8px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-4">
                    <div className="mb-3">
                      <h3 className="text-[15px] font-medium text-[var(--vk-text-strong)]">
                        Routing
                      </h3>
                      <p className="pt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                        Choose where the card lands and how it should be tagged.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      <label className="block">
                        <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                          Column
                        </span>
                        <select
                          value={composerRole}
                          onChange={(event) =>
                            setComposerRole(toRole(event.target.value))
                          }
                          className="h-10 w-full rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.14)] px-3 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                        >
                          {allColumns.map((column) => (
                            <option
                              key={column.role}
                              value={column.role}
                              className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]"
                            >
                              {column.heading || ROLE_LABEL[column.role]}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                          Agent
                        </span>
                        <AgentSelectMenu
                          value={agent}
                          options={orderedAgentOptions}
                          disabled={submitting}
                          onChange={setAgent}
                          ariaLabel="Select agent for new task"
                        />
                      </label>
                    </div>

                    <div className="mt-4">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                        Task type
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {TASK_TYPE_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setTaskType(option.value)}
                            className={cn(
                              "inline-flex h-8 items-center rounded-full border px-3 text-[12px] transition-colors",
                              taskType === option.value
                                ? "border-[var(--vk-orange)] bg-[var(--vk-orange)]/10 text-[var(--vk-text-strong)]"
                                : "border-[var(--vk-border)] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
                            )}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="mt-4">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                        Priority
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {PRIORITY_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setPriority(option.value)}
                            className={cn(
                              "inline-flex h-8 items-center rounded-full border px-3 text-[12px] transition-colors",
                              priority === option.value
                                ? option.value === "high"
                                  ? "border-[var(--vk-red)] bg-[var(--vk-red)]/10 text-[var(--vk-text-strong)]"
                                  : option.value === "medium"
                                  ? "border-[var(--vk-orange)] bg-[var(--vk-orange)]/10 text-[var(--vk-text-strong)]"
                                  : "border-[var(--vk-border)] bg-[rgba(255,255,255,0.05)] text-[var(--vk-text-strong)]"
                                : "border-[var(--vk-border)] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
                            )}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-[8px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-[15px] font-medium text-[var(--vk-text-strong)]">
                          Context
                        </h3>
                        <p className="pt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                          Attach notes, screenshots, or files the agent should
                          inspect before making changes.
                        </p>
                      </div>
                      <label className="inline-flex h-9 cursor-pointer items-center rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]">
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
                                const exists = merged.some(
                                  (entry) =>
                                    entry.name === file.name &&
                                    entry.size === file.size &&
                                    entry.lastModified === file.lastModified
                                );
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

                    <div className="mt-3 rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.12)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                      {selectedContextPaths.length} existing file
                      {selectedContextPaths.length === 1 ? "" : "s"} selected
                      {uploadFiles.length > 0
                        ? ` · ${uploadFiles.length} upload${uploadFiles.length === 1 ? "" : "s"} ready`
                        : ""}
                    </div>

                    {selectedContextFiles.length > 0 && (
                      <div className="mt-3">
                        <span className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                          Selected files
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedContextFiles.map((file) => (
                            <button
                              key={file.path}
                              type="button"
                              onClick={() => toggleContextPath(file.path)}
                              className="inline-flex max-w-full items-center gap-1 rounded-[999px] border border-[var(--vk-border)] bg-[var(--vk-bg-hover)] px-2.5 py-1 text-[11px] text-[var(--vk-text-normal)]"
                              title={`Remove ${getContextFileDisplayPath(file)}`}
                            >
                              <span className="truncate max-w-[220px]">
                                {file.name}
                              </span>
                              <span className="text-[var(--vk-text-muted)]">
                                ×
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {uploadFiles.length > 0 && (
                      <div className="mt-3">
                        <span className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                          Pending uploads
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {uploadFiles.map((file) => (
                            <button
                              key={`${file.name}-${file.size}-${file.lastModified}`}
                              type="button"
                              onClick={() => removeUploadFile(file)}
                              className="inline-flex max-w-full items-center gap-1 rounded-[999px] border border-[var(--vk-border)] bg-[var(--vk-bg-hover)] px-2.5 py-1 text-[11px] text-[var(--vk-text-normal)]"
                              title="Remove upload"
                            >
                              <span className="truncate max-w-[220px]">
                                {file.name}
                              </span>
                              <span className="text-[var(--vk-text-muted)]">
                                ×
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <label className="mt-4 block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                        Browse existing context
                      </span>
                      <div className="flex h-9 items-center rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.14)] px-3">
                        <Search className="h-3.5 w-3.5 text-[var(--vk-text-muted)]" />
                        <input
                          value={contextSearch}
                          onChange={(event) => setContextSearch(event.target.value)}
                          placeholder="Search context files..."
                          className="ml-2 w-full bg-transparent text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                        />
                      </div>
                    </label>

                    <div className="mt-3 max-h-[320px] overflow-auto rounded-[6px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.08)]">
                      {contextLoading ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Loading context files...</span>
                        </div>
                      ) : contextError ? (
                        <p className="px-3 py-3 text-[12px] text-[var(--vk-red)]">
                          {contextError}
                        </p>
                      ) : filteredContextFiles.length === 0 ? (
                        <p className="px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                          No context files found.
                        </p>
                      ) : (
                        <ul className="py-1">
                          {filteredContextTree.map((node) => (
                            <ContextTreeRow
                              key={node.path}
                              node={node}
                              depth={0}
                              expandedFolders={effectiveExpandedContextFolders}
                              selectedPaths={selectedContextPaths}
                              openingContextPath={openingContextPath}
                              contextOpenLabel={contextOpenLabel}
                              onToggleFolder={toggleContextFolder}
                              onTogglePath={toggleContextPath}
                              onOpenPath={(path) =>
                                void openContextAttachment(path)
                              }
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {submitError && (
              <div className="border-t border-[var(--vk-border)] px-4 py-3 sm:px-5">
                <p className="text-[12px] text-[var(--vk-red)]">
                  {submitError}
                </p>
              </div>
            )}

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--vk-border)] px-4 py-3 sm:px-5">
              <div className="text-[12px] text-[var(--vk-text-muted)]">
                {title.trim()
                  ? "Task is ready to add to the board."
                  : "Add a clear title to enable task creation."}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
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
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Create Task"
                )}
              </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
