// @ts-nocheck
// DEPRECATED: This monolith is no longer imported. Kept for reference only.
// New UI lives in components/layout/, components/sessions/, components/agents/, components/ui/
"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type {
  DashboardSession,
  DashboardStats,
  SSESnapshotEvent,
} from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { TERMINAL_STATUSES } from "@conductor-oss/core/types";
import { SessionCard } from "./SessionCard";
import { EmptyState } from "./EmptyState";
import { useTheme } from "./ThemeProvider";

type ConfigProject = {
  id: string;
  boardDir: string;
  boardFile?: string;
  repo: string | null;
  iconUrl?: string | null;
  description: string | null;
  agent: string;
};
type AgentInfo = {
  name: string;
  description: string | null;
  version: string | null;
  homepage: string | null;
  iconUrl: string | null;
};

type DashboardTab = "overview" | "chat" | "review" | "agents";
type ReviewDiffSource = "working-tree" | "remote-pr" | "not-found";

type AgentRoster = {
  name: string;
  label: string;
  launchName: string;
  known: boolean;
  installed: boolean;
  description: string | null;
  version: string | null;
  homepage: string | null;
  iconUrl: string | null;
  capabilities: string[];
  commandHint: string | null;
  totalSessions: number;
  activeSessions: number;
  attentionSessions: number;
};

type ReviewDiffKind = "meta" | "hunk" | "context" | "add" | "remove" | "info";

interface ReviewDiffLine {
  kind: ReviewDiffKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface ReviewDiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copy" | "binary" | "unknown";
  additions: number;
  deletions: number;
  lines: ReviewDiffLine[];
}

interface ReviewDiffPayload {
  hasDiff: boolean;
  generatedAt: string;
  source: ReviewDiffSource;
  truncated: boolean;
  files: ReviewDiffFile[];
  untracked: string[];
  error?: string;
}

type ReviewDiffResponse = ReviewDiffPayload | { error: string };

type CICheckStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "unknown";

interface CICheckInfo {
  name: string;
  status: CICheckStatus;
  url?: string;
}

interface CIChecksPayload {
  sessionId: string;
  source: string;
  ciStatus: "pending" | "passing" | "failing" | "none";
  checks: CICheckInfo[];
  generatedAt: string;
}

interface SessionChecksState {
  loading: boolean;
  loaded: boolean;
  ciStatus: "pending" | "passing" | "failing" | "none";
  checks: CICheckInfo[];
  source: string;
  generatedAt: string;
  error: string | null;
}

type LogoIconProps = {
  className?: string;
  fillColor?: string;
};

interface ReviewDiffState {
  loading: boolean;
  loaded: boolean;
  hasDiff: boolean;
  source: ReviewDiffSource;
  truncated: boolean;
  files: ReviewDiffFile[];
  untracked: string[];
  generatedAt: string;
  selectedFilePath: string | null;
  fileSearch: string;
  search: string;
  wrapLines: boolean;
  error: string | null;
}

type KnownAgent = {
  id: string;
  label: string;
  launchName: string;
  aliases?: string[];
  description: string;
  homepage?: string;
  iconUrl?: string;
  installHint?: string;
  launchCommand?: string;
  capabilities?: string[];
};

type AgentIconSeed = {
  label: string;
  launchName: string;
  iconUrl?: string | null;
  homepage?: string | null;
};

function asSimpleIconSlug(value: string): string {
  return normalizeAgentName(value);
}

function normalizeAgentName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveRepoUrl(repo?: string | null): string | null {
  if (!repo) return null;
  const trimmed = repo.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("github.com/") || trimmed.startsWith("www.github.com/")) {
    return `https://${trimmed}`;
  }

  if (trimmed.includes("/")) {
    return `https://github.com/${trimmed}`;
  }

  return null;
}

function parseGithubRepo(repo: string | null): { owner: string; name: string } | null {
  const resolved = resolveRepoUrl(repo);
  if (!resolved) return null;
  try {
    const url = new URL(resolved);
    const isGithub =
      url.hostname === "github.com" ||
      url.hostname === "www.github.com" ||
      url.hostname.endsWith(".github.com");
    if (!isGithub) return null;

    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;

    return {
      owner: parts[0],
      name: parts[1],
    };
  } catch {
    return null;
  }
}

function getProjectFaviconUrls(repo?: string | null, iconUrl?: string | null): string[] {
  if (iconUrl) {
    const normalized = iconUrl.trim();
    if (!normalized) return [];
    if (!/^https?:\/\//i.test(normalized)) return [];
    return [iconUrl.trim()];
  }

  const resolved = resolveRepoUrl(repo);
  try {
    if (!resolved) return [];
    const url = new URL(resolved);
    const github = parseGithubRepo(repo ?? null);
    if (github) {
      const owner = encodeURIComponent(github.owner);
      const project = encodeURIComponent(github.name);
      const repoIconFiles = [
        "favicon.ico",
        "public/favicon.ico",
        "assets/favicon.ico",
        ".github/favicon.ico",
        "static/favicon.ico",
        "logo.png",
        "public/logo.png",
        "assets/logo.png",
        ".github/logo.png",
      ];
      const repoAssetUrls = repoIconFiles.map((file) => `https://raw.githubusercontent.com/${owner}/${project}/HEAD/${file}`);
      return [...new Set([...repoAssetUrls, `https://opengraph.githubassets.com/1/${owner}/${project}`])];
    }

    return [
      `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(url.toString())}`,
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(url.hostname)}.ico`,
      `https://api.faviconkit.com/${encodeURIComponent(url.hostname)}/64`,
    ];
  } catch {
    return [];
  }
}

function getAgentIconUrls(agent: AgentIconSeed): string[] {
  const urls: string[] = [];

  if (agent.iconUrl) {
    const direct = agent.iconUrl.trim();
    if (direct) {
      urls.push(direct);
    }
  }

  const simpleIconCandidates = [
    asSimpleIconSlug(agent.label),
    asSimpleIconSlug(agent.launchName),
    asSimpleIconSlug(agent.launchName).replace(/-cli$/u, ""),
  ].filter((slug) => slug.length > 0);
  for (const slug of simpleIconCandidates) {
    urls.push(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`);
  }

  if (!agent.homepage) return urls;

  try {
    const homepageUrl = new URL(agent.homepage);
    const homepageOrigin = `${homepageUrl.origin}`;
    urls.push(`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(homepageOrigin)}`);
    urls.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(homepageUrl.hostname)}`);
    const gitHubRepo = parseGithubRepo(agent.homepage);
    if (gitHubRepo) {
      const owner = encodeURIComponent(gitHubRepo.owner);
      const project = encodeURIComponent(gitHubRepo.name);
      urls.push(`https://opengraph.githubassets.com/1/${owner}/${project}`);
      const repoFiles = [
        ".github/logo.png",
        ".github/favicon.png",
        ".github/logo.svg",
        "assets/logo.png",
        "assets/favicon.png",
        "logo.png",
        "favicon.png",
        "logo.svg",
      ];
      urls.push(...repoFiles.map((file) => `https://raw.githubusercontent.com/${owner}/${project}/HEAD/${file}`));
    }
  } catch {
    // Ignore malformed homepages.
  }

  return [...new Set(urls)];
}

function getProjectAbbrev(projectId: string): string {
  const parts = projectId.split(/[-_\s/]+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function DefaultProjectIcon({ projectId, color }: { projectId: string; color: string }) {
  const fallback = getProjectAbbrev(projectId);
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold text-white"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {fallback}
    </span>
  );
}

function DefaultAgentIcon({
  label,
  color,
  className = "h-5 w-5",
}: {
  label: string;
  color: string;
  className?: string;
}) {
  const fallback = getProjectAbbrev(label);
  return (
    <span
      className={`flex ${className} shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold text-white`}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {fallback}
    </span>
  );
}

function getSeededColor(seed: string): string {
  const FALLBACK_COLORS = [
    "#14b8a6",
    "#22c55e",
    "#84cc16",
    "#eab308",
    "#f97316",
    "#f43f5e",
    "#a855f7",
    "#ec4899",
    "#06b6d4",
    "#0ea5e9",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? "#6b7280";
}

function AgentIcon({ agent, className = "h-5 w-5" }: { agent: AgentIconSeed; className?: string }) {
  const [iconErrorIndex, setIconErrorIndex] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const iconUrls = useMemo(() => getAgentIconUrls(agent), [agent.iconUrl, agent.homepage, agent.label, agent.launchName]);
  const color = useMemo(
    () => getSeededColor(`${agent.label}-${agent.launchName}`),
    [agent.label, agent.launchName],
  );

  useEffect(() => {
    setIconErrorIndex(0);
    setIsLoaded(false);
  }, [iconUrls]);
  useEffect(() => setIsLoaded(false), [iconErrorIndex]);

  const shouldUseFallback =
    !iconUrls.length || iconErrorIndex >= iconUrls.length || !iconUrls[iconErrorIndex];

  if (shouldUseFallback) {
    return <DefaultAgentIcon className={className} label={agent.label} color={color} />;
  }

  return (
    <span className="relative inline-flex">
      {!isLoaded && <DefaultAgentIcon className={className} label={agent.label} color={color} />}
      <img
        src={iconUrls[iconErrorIndex]}
        alt={`${agent.label} icon`}
        className={`${className} shrink-0 rounded-sm border border-[var(--color-border-subtle)] bg-white object-contain ${isLoaded ? "inline-flex" : "hidden"}`}
        onError={() => {
          setIconErrorIndex((current) => current + 1);
          setIsLoaded(false);
        }}
        onLoad={() => setIsLoaded(true)}
        loading="lazy"
      />
    </span>
  );
}

const KNOWN_AGENTS: KnownAgent[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    launchName: "claude-code",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
    aliases: [
      "claude code",
      "claude-code",
      "claude_code",
      "claude-code-cli",
      "cc",
      "claude",
      "claude-cli",
      "claudecode",
    ],
    description: "Claude Code CLI",
    homepage: "https://www.anthropic.com/claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    launchCommand: "claude-code",
    capabilities: ["chat", "review", "code review", "agentic"],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    launchName: "codex",
    aliases: [
      "openai-codex",
      "openai_codex",
      "openai codex",
      "openai",
      "open-ai",
      "open ai",
      "openai-codex-cli",
      "codexcli",
      "codex",
    ],
    description: "OpenAI Codex CLI",
    homepage: "https://github.com/openai/codex",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
    installHint: "npm install -g @openai/codex-cli",
    launchCommand: "codex",
    capabilities: ["chat", "review", "terminal"],
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    launchName: "github-copilot",
    aliases: ["github copilot", "github_copilot", "copilot", "copilot-cli", "gh-copilot"],
    description: "GitHub Copilot CLI",
    homepage: "https://github.com/github/copilot-cli",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
    installHint: "npm install -g @githubnext/github-copilot-cli",
    launchCommand: "github-copilot",
    capabilities: ["chat", "suggestions", "pairing"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    launchName: "gemini",
    aliases: [
      "google-gemini",
      "google_gemini",
      "google-gemini-cli",
      "gemini-cli",
      "gemini_cli",
      "gemini",
      "gm",
      "gemini cli",
    ],
    description: "Google Gemini CLI",
    homepage: "https://ai.google.dev/gemini-api/docs",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
    installHint: "npm install -g @google/gemini-cli",
    launchCommand: "gemini",
    capabilities: ["chat", "review", "research", "analysis"],
  },
  {
    id: "amp",
    label: "Amp",
    launchName: "amp",
    aliases: ["amp-cli", "amp cli", "amp"],
    description: "Amp Code",
    homepage: "https://www.ampcode.com",
    iconUrl: "https://ampcode.com/amp-mark-color.svg",
    launchCommand: "amp",
    capabilities: ["chat", "automation", "code generation"],
  },
  {
    id: "cursor-cli",
    label: "Cursor",
    launchName: "cursor-cli",
    aliases: [
      "cursor cli",
      "cursor_cli",
      "cursoragent",
      "cursor-agent",
      "cursor-agent-cli",
      "cursor_agent",
      "cursor",
    ],
    description: "Cursor Agent CLI",
    homepage: "https://www.cursor.com",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
    launchCommand: "cursor-cli",
    capabilities: ["chat", "review", "multi-agent"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    launchName: "opencode",
    aliases: ["open code", "open_code", "open-code", "open-code-cli", "opencode"],
    description: "SST OpenCode",
    homepage: "https://opencode.ai",
    launchCommand: "opencode",
    capabilities: ["chat", "review", "tooling"],
  },
  {
    id: "droid",
    label: "Droid CLI",
    launchName: "droid",
    description: "Factory Droid",
    iconUrl: "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
    homepage: "https://github.com/Factory-AI/factory",
    launchCommand: "droid",
    capabilities: ["chat", "automation", "terminal"],
  },
  {
    id: "ccr",
    label: "Claude Code Router",
    launchName: "ccr",
    aliases: ["claude-code-router", "claude_code_router", "ccr", "ccr-cli"],
    description: "Claude Code Router",
    homepage: "https://github.com/mckaywrigley/claude-code-router",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
    launchCommand: "ccr",
    capabilities: ["chat", "routing", "multi-provider"],
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    launchName: "qwen-code",
    aliases: ["qwen code", "qwen_code", "qwen", "qwen-code", "qwen-code-cli"],
    description: "Qwen Code CLI",
    homepage: "https://qwenlm.github.io/announcements/",
    launchCommand: "qwen-code",
    capabilities: ["chat", "review", "reasoning", "analysis"],
  },
];

const KNOWN_AGENT_LAUNCH_BY_ID = Object.fromEntries(
  KNOWN_AGENTS.map((agent) => [normalizeAgentName(agent.id), normalizeAgentName(agent.launchName)]),
) as Record<string, string>;

const KNOWN_AGENT_ID_BY_LAUNCH = Object.fromEntries(
  KNOWN_AGENTS.flatMap((agent) => [
    [normalizeAgentName(agent.launchName), agent.id],
    ...(agent.aliases ?? []).map((alias) => [normalizeAgentName(alias), agent.id] as const),
  ]),
) as Record<string, string>;

const KNOWN_AGENT_BY_ID = Object.fromEntries(
  KNOWN_AGENTS.map((agent) => [normalizeAgentName(agent.id), agent.label]),
) as Record<string, string>;

const KNOWN_AGENT_BY_LAUNCH = Object.fromEntries(
  KNOWN_AGENTS.flatMap((agent) => [
    [normalizeAgentName(agent.launchName), agent],
    ...(agent.aliases ?? []).map((alias) => [normalizeAgentName(alias), agent] as const),
  ]),
) as Record<string, KnownAgent>;

function getKnownAgent(agentName: string): KnownAgent | undefined {
  const normalized = normalizeAgentName(agentName);
  if (!normalized) return undefined;
  return KNOWN_AGENT_BY_LAUNCH[normalized] ?? KNOWN_AGENTS.find((agent) => normalizeAgentName(agent.id) === normalized);
}

const TAB_DEFINITIONS: Array<{ id: DashboardTab; label: string; subtitle: string }> = [
  { id: "overview", label: "Overview", subtitle: "All sessions and controls" },
  { id: "chat", label: "Chat", subtitle: "Respond to agents in need of action" },
  { id: "review", label: "Review", subtitle: "Send review feedback quickly" },
  { id: "agents", label: "Agents", subtitle: "Health and launch controls" },
];

const EMPTY_REVIEW_DIFF: ReviewDiffState = {
  loading: false,
  loaded: false,
  hasDiff: false,
  source: "working-tree",
  truncated: false,
  files: [],
  untracked: [],
  generatedAt: "",
  selectedFilePath: null,
  fileSearch: "",
  search: "",
  wrapLines: false,
  error: null,
};

const EMPTY_SESSION_CHECKS: SessionChecksState = {
  loading: false,
  loaded: false,
  ciStatus: "none",
  checks: [],
  source: "not-loaded",
  generatedAt: "",
  error: null,
};

const CHAT_QUICK_ACTIONS = [
  {
    label: "Ask for status",
    message: "Can you share the current blocker and exact next step?",
  },
  {
    label: "Request progress",
    message: "Give me a concise 3-point progress update with blockers.",
  },
  {
    label: "Need clarifications",
    message: "Please provide 2–3 concise clarifying questions before continuing.",
  },
] as const;

const REVIEW_QUICK_ACTIONS = [
  {
    label: "Request fix summary",
    message: "Please summarize what changed and why this is still pending.",
  },
  {
    label: "Run focused tests",
    message: "Please run focused tests for touched files and report failures.",
  },
  {
    label: "Rebase + clean checks",
    message: "Please rebase with latest main and re-run checks cleanly.",
  },
] as const;

const CI_STATUS_META: Record<CICheckState, { label: string; dot: string; color: string }> = {
  pending: {
    label: "Pending",
    dot: "bg-[var(--color-status-attention)]",
    color: "rgba(245, 158, 11, 0.2)",
  },
  passing: {
    label: "Passing",
    dot: "bg-[var(--color-status-ready)]",
    color: "rgba(74, 222, 128, 0.18)",
  },
  failing: {
    label: "Failing",
    dot: "bg-[var(--color-status-error)]",
    color: "rgba(248, 113, 113, 0.2)",
  },
  none: {
    label: "Not run",
    dot: "bg-[var(--color-text-muted)]",
    color: "rgba(148, 163, 184, 0.18)",
  },
};

type CICheckState = "pending" | "passing" | "failing" | "none";
const CI_AUTO_REFRESH_MS = 30_000;
const CI_PENDING_REFRESH_MS = 7_000;
const DIFF_AUTO_LOAD_DELAY_MS = 1_250;

type AttentionGroup = "respond" | "review" | "merge" | "pending" | "working" | "done";
type StatusFilter = "all" | "active" | "terminal" | "attention";
type SortMode = "recent" | "oldest" | "cost" | "attention";
type ViewMode = "grid" | "lanes";
type CleanupDialogKind = "single" | "terminal-bulk";
type CleanupAction = "cleanup" | "kill" | "restore";

type CleanupDialogState = {
  open: boolean;
  kind: CleanupDialogKind;
  action: CleanupAction;
  title: string;
  message: string;
  sessionIds: string[];
  isTerminalSession: boolean;
};

const FALLBACK_MERGEABILITY = {
  mergeable: false,
  ciPassing: false,
  approved: false,
  noConflicts: true,
  blockers: [],
};

function metadataEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

function prEqual(left: DashboardSession["pr"], right: DashboardSession["pr"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;

  if (
    left.number !== right.number ||
    left.url !== right.url ||
    left.title !== right.title ||
    left.branch !== right.branch ||
    left.baseBranch !== right.baseBranch ||
    left.isDraft !== right.isDraft ||
    left.state !== right.state ||
    left.ciStatus !== right.ciStatus ||
    left.reviewDecision !== right.reviewDecision ||
    left.previewUrl !== right.previewUrl
  ) {
    return false;
  }

  const leftMergeability = left.mergeability;
  const rightMergeability = right.mergeability;
  if (
    leftMergeability.mergeable !== rightMergeability.mergeable ||
    leftMergeability.ciPassing !== rightMergeability.ciPassing ||
    leftMergeability.approved !== rightMergeability.approved ||
    leftMergeability.noConflicts !== rightMergeability.noConflicts ||
    leftMergeability.blockers.length !== rightMergeability.blockers.length
  ) {
    return false;
  }

  return leftMergeability.blockers.every((blocker, index) => blocker === rightMergeability.blockers[index]);
}

function normalizeSnapshotPr(
  pr: NonNullable<SSESnapshotEvent["sessions"][number]["pr"]> | null,
): DashboardSession["pr"] {
  if (!pr) return null;
  const mergeability = pr.mergeability
    ? {
        ...FALLBACK_MERGEABILITY,
        ...pr.mergeability,
      }
    : FALLBACK_MERGEABILITY;

  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    isDraft: pr.isDraft,
    state: pr.state,
    ciStatus: pr.ciStatus,
    reviewDecision: pr.reviewDecision,
    mergeability,
    previewUrl: pr.previewUrl ?? null,
  };
}

interface DashboardProps {
  sessions: DashboardSession[];
  stats: DashboardStats;
  configProjects?: ConfigProject[];
}

export function Dashboard({ sessions: initialSessions, stats: initialStats, configProjects: initialConfigProjects = [] }: DashboardProps) {
  const router = useRouter();
  const [sessions, setSessions] = useState<DashboardSession[]>(initialSessions);
  const [stats, setStats] = useState<DashboardStats>(initialStats);
  const [configProjects, setConfigProjects] = useState<ConfigProject[]>(initialConfigProjects);
  const [connected, setConnected] = useState(false);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [availableAgents, setAvailableAgents] = useState<AgentInfo[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [cleanupDialog, setCleanupDialog] = useState<CleanupDialogState>({
    open: false,
    kind: "single",
    action: "cleanup",
    title: "",
    message: "",
    sessionIds: [],
    isTerminalSession: false,
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("overview");
  const [isLaunchCollapsed, setIsLaunchCollapsed] = useState(true);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [launchProjectId, setLaunchProjectId] = useState("");
  const [launchIssueId, setLaunchIssueId] = useState("");
  const [launchAgent, setLaunchAgent] = useState("auto");
  const [launchModel, setLaunchModel] = useState("");
  const [launchProfile, setLaunchProfile] = useState("");
  const [launchBranch, setLaunchBranch] = useState("");
  const [launchBaseBranch, setLaunchBaseBranch] = useState("");
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [launchLoading, setLaunchLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<Record<string, string>>({});
  const [reviewMessages, setReviewMessages] = useState<Record<string, string>>({});
  const [chatSendingSession, setChatSendingSession] = useState<string | null>(null);
  const [reviewSendingSession, setReviewSendingSession] = useState<string | null>(null);
  const [reviewDiffState, setReviewDiffState] = useState<Record<string, ReviewDiffState>>({});
  const [sessionChecksState, setSessionChecksState] = useState<Record<string, SessionChecksState>>({});
  const reviewDiffLoadTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const { theme, toggleTheme } = useTheme();

  const isTrackableSessionForChecks = useCallback((session: DashboardSession): boolean => {
    return Boolean(
      session.pr && session.pr.number > 0,
    );
  }, []);

  const refreshConfigProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) return;
      const data = (await res.json()) as { projects: ConfigProject[] };
      if (Array.isArray(data.projects)) {
        setConfigProjects(data.projects);
      }
    } catch {
      // Keep previous projects if config endpoint is unavailable.
    }
  }, []);

  // SSE connection for live updates
  // Refresh configured projects every few seconds so board/project changes
  // appear without requiring a full dashboard restart.
  useEffect(() => {
    void refreshConfigProjects();
    const configPoller = setInterval(() => {
      void refreshConfigProjects();
    }, 5000);
    return () => clearInterval(configPoller);
  }, [refreshConfigProjects]);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agents");
        if (!res.ok) return;
        const data = (await res.json()) as { agents?: AgentInfo[] };
        if (canceled) return;
        if (Array.isArray(data.agents)) {
          const dedupe = new Map<string, AgentInfo>();
          for (const agent of data.agents) {
            if (!agent?.name) continue;
            const next = dedupe.get(agent.name) ?? {
              name: agent.name,
              description: agent.description ?? null,
              version: agent.version ?? null,
              homepage: agent.homepage ?? null,
              iconUrl: agent.iconUrl ?? null,
            };
            dedupe.set(agent.name, next);
          }
          setAvailableAgents(Array.from(dedupe.values()));
        }
      } catch {
        // Keep fallback behavior if agent catalog is unavailable.
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as SSESnapshotEvent;
        if (data.type === "snapshot" && data.sessions) {
          setSessions((prev) => {
            const updates = new Map(data.sessions.map((s) => [s.id, s]));
            const prevIds = new Set(prev.map((s) => s.id));
            const removedIds = new Set<string>();
            for (const id of prevIds) {
              if (!updates.has(id)) removedIds.add(id);
            }
            const newSessionIds: string[] = [];
            for (const id of updates.keys()) {
              if (!prevIds.has(id)) newSessionIds.push(id);
            }

            let changed = removedIds.size > 0 || newSessionIds.length > 0;

            const next = prev
              .filter((s) => !removedIds.has(s.id))
              .map((session) => {
                const update = updates.get(session.id);
                if (!update) return session;

                const updatePr = normalizeSnapshotPr(update.pr ?? null);
                const mergedSession: DashboardSession = {
                  ...session,
                  status: update.status,
                  activity: update.activity,
                  lastActivityAt: update.lastActivityAt,
                  createdAt: update.createdAt,
                  projectId: update.projectId,
                  issueId: update.issueId ?? null,
                  branch: update.branch ?? null,
                  metadata: update.metadata,
                  summary: update.summary === undefined ? session.summary : update.summary,
                  pr: updatePr,
                };

                const metadataChanged = !metadataEqual(session.metadata, mergedSession.metadata);
                const summaryChanged = mergedSession.summary !== session.summary;
                const prChanged = !prEqual(session.pr, mergedSession.pr);
                const sessionChanged = (
                  update.status !== session.status ||
                  update.activity !== session.activity ||
                  mergedSession.lastActivityAt !== session.lastActivityAt ||
                  mergedSession.createdAt !== session.createdAt ||
                  mergedSession.projectId !== session.projectId ||
                  mergedSession.issueId !== session.issueId ||
                  mergedSession.branch !== session.branch ||
                  summaryChanged ||
                  metadataChanged ||
                  prChanged
                );

                if (sessionChanged) {
                  changed = true;
                  return mergedSession;
                }

                return session;
              });

            for (const id of newSessionIds) {
              const update = updates.get(id)!;
              next.push({
                id,
                status: update.status,
                activity: update.activity,
                createdAt: update.createdAt,
                lastActivityAt: update.lastActivityAt,
                summary: update.summary ?? null,
                projectId: update.projectId,
                issueId: update.issueId ?? null,
                branch: update.branch ?? null,
                metadata: update.metadata,
                pr: normalizeSnapshotPr(update.pr ?? null),
              });
            }

            return changed ? next : prev;
          });
        }
      } catch {
        // Ignore malformed SSE events
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  // Poll /api/sessions every 5s for full data refresh
  const pollSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: DashboardSession[]; stats: DashboardStats };
      setSessions(data.sessions);
      setStats(data.stats);
    } catch {
      // ignore poll errors
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => void pollSessions(), 3000);
    return () => clearInterval(interval);
  }, [pollSessions]);

  // Recompute stats when sessions change
  useEffect(() => {
    setStats({
      totalSessions: sessions.length,
      workingSessions: sessions.filter((s) => s.activity === "active").length,
      openPRs: sessions.filter((s) => s.pr?.state === "open").length,
      needsAttention: sessions.filter(
        (s) =>
          s.status === "needs_input" ||
          s.status === "stuck" ||
          s.status === "errored" ||
          s.activity === "waiting_input" ||
          s.activity === "blocked"
      ).length,
    });
  }, [sessions]);

  useEffect(() => {
    if (activeProject) {
      setLaunchProjectId(activeProject);
    } else if (!launchProjectId && configProjects.length > 0) {
      setLaunchProjectId(configProjects[0]?.id ?? "");
    }
  }, [activeProject, configProjects, launchProjectId]);

  // Merge config projects + session-derived counts for sidebar
  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sess of sessions) {
      const pid = sess.projectId || "default";
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    const allIds = new Set([...configProjects.map((p) => p.id), ...counts.keys()]);
    return [...allIds].sort().map((id) => {
      const cfg = configProjects.find((p) => p.id === id);
      return {
        id,
        count: counts.get(id) ?? 0,
        boardDir: cfg?.boardDir ?? id,
        boardFile: cfg?.boardFile,
        repo: cfg?.repo ?? null,
        iconUrl: cfg?.iconUrl ?? null,
      };
    });
  }, [sessions, configProjects]);

  const sessionAgentOptions = useMemo(() => {
    const unique = new Set<string>();
    for (const session of sessions) {
      const agent = normalizeAgentName(session.metadata["agent"] ?? "");
      if (agent) unique.add(agent);
    }
    return [...unique].sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const discoveredAgentOptions = useMemo(() => {
    const set = new Set<string>(sessionAgentOptions);
    for (const agent of availableAgents) {
      const normalized = normalizeAgentName(agent.name);
      if (normalized) {
        set.add(normalized);
      }
    }
    const ordered = [...set].sort((a, b) => a.localeCompare(b));
    return ordered;
  }, [availableAgents, sessionAgentOptions]);

  const launchAgentOptions = useMemo(() => {
    const set = new Set<string>(discoveredAgentOptions);
    for (const known of KNOWN_AGENTS) {
      set.add(known.id);
      set.add(known.launchName);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [discoveredAgentOptions]);

  const trackedSessionIds = useMemo(
    () => sessions
      .filter(isTrackableSessionForChecks)
      .map((session) => session.id)
      .sort(),
    [sessions, isTrackableSessionForChecks],
  );

  const availableAgentMetadata = useMemo(() => {
    const map = new Map<string, AgentInfo>();
    for (const agent of availableAgents) {
      const normalized = normalizeAgentName(agent.name);
      if (!normalized) continue;

      map.set(normalized, agent);

      const launchName = KNOWN_AGENT_LAUNCH_BY_ID[normalized];
      if (launchName) {
        map.set(normalizeAgentName(launchName), agent);
      }

      const knownId = KNOWN_AGENT_ID_BY_LAUNCH[normalized];
      if (knownId) {
        map.set(normalizeAgentName(knownId), agent);
      }
    }
    return map;
  }, [availableAgents]);

  const normalizeLaunchAgent = (rawAgent: string): string => {
    const normalized = normalizeAgentName(rawAgent);
    if (!normalized) return "";
    const canonicalId = KNOWN_AGENT_ID_BY_LAUNCH[normalized];
    if (canonicalId) {
      return KNOWN_AGENT_LAUNCH_BY_ID[normalizeAgentName(canonicalId)] ?? normalized;
    }
    return KNOWN_AGENT_LAUNCH_BY_ID[normalized] ?? normalized;
  };

  // Filtered + sorted sessions
  const filteredSessions = useMemo(() => {
    let next = sessions;

    if (activeProject) {
      next = next.filter((s) => (s.projectId || "default") === activeProject);
    }

    if (statusFilter === "active") {
      next = next.filter((s) => !TERMINAL_STATUSES.has(s.status));
    } else if (statusFilter === "terminal") {
      next = next.filter((s) => TERMINAL_STATUSES.has(s.status));
    } else if (statusFilter === "attention") {
      next = next.filter((s) => {
        const level = getAttentionLevel(s);
        return level === "respond" || level === "review" || level === "merge";
      });
    }

    if (attentionOnly) {
      next = next.filter((s) => {
        const level = getAttentionLevel(s);
        return level === "respond" || level === "review" || level === "merge";
      });
    }

    if (agentFilter !== "all") {
      next = next.filter(
        (s) => normalizeAgentName(s.metadata["agent"] ?? "") === agentFilter,
      );
    }

    const query = search.trim().toLowerCase();
    if (query.length > 0) {
      next = next.filter((s) => {
        const haystack = [
          s.id,
          s.projectId,
          s.issueId ?? "",
          s.branch ?? "",
          s.summary ?? "",
          s.status,
          s.activity ?? "",
          s.metadata["agent"] ?? "",
          s.pr?.title ?? "",
          s.pr?.url ?? "",
        ].join("\n").toLowerCase();
        return haystack.includes(query);
      });
    }

    const ranked = [...next];
    ranked.sort((a, b) => {
      if (sortMode === "oldest") {
        return new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime();
      }
      if (sortMode === "cost") {
        return parseEstimatedCost(b) - parseEstimatedCost(a);
      }
      if (sortMode === "attention") {
        return attentionRank(a) - attentionRank(b);
      }
      return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    });

    return ranked;
  }, [sessions, activeProject, statusFilter, attentionOnly, agentFilter, search, sortMode]);

  const reviewSessions = useMemo(() => {
    return filteredSessions.filter((session) => {
      if (session.pr && session.pr.number > 0) return true;
      const diff = reviewDiffState[session.id];
      if (!diff) return true;
      if (!diff.loaded) return true;
      return diff.hasDiff || diff.untracked.length > 0;
    });
  }, [filteredSessions, reviewDiffState]);

  const chatSessions = useMemo(
    () => filteredSessions.filter((session) => getAttentionLevel(session) === "respond"),
    [filteredSessions],
  );

  const agentRoster = useMemo(() => {
    const map = new Map<string, AgentRoster>();

    for (const known of KNOWN_AGENTS) {
      const launchName = KNOWN_AGENT_LAUNCH_BY_ID[known.id] ?? known.id;
      const info = availableAgentMetadata.get(launchName) ?? availableAgentMetadata.get(known.id);
      map.set(known.id, {
        name: known.id,
        label: known.label,
        launchName,
        known: true,
        installed: discoveredAgentOptions.includes(launchName) || discoveredAgentOptions.includes(known.id),
        description: info?.description ?? known.description,
        version: info?.version ?? null,
        homepage: info?.homepage ?? known.homepage ?? null,
        iconUrl: info?.iconUrl ?? known.iconUrl ?? null,
        capabilities: known.capabilities ?? [],
        commandHint: known.launchCommand ?? null,
        totalSessions: 0,
        activeSessions: 0,
        attentionSessions: 0,
      });
    }

    for (const discovered of discoveredAgentOptions) {
      const canonical = KNOWN_AGENT_ID_BY_LAUNCH[discovered] ?? discovered;
      if (map.has(canonical)) continue;
      const info = availableAgentMetadata.get(discovered);
      const metadata = info ?? availableAgentMetadata.get(normalizeAgentName(canonical));
      map.set(canonical, {
        name: canonical,
        label: KNOWN_AGENT_BY_ID[canonical] ?? discovered,
        launchName: discovered,
        known: false,
        installed: discoveredAgentOptions.includes(discovered),
        description: metadata?.description ?? "Agent plugin currently detected",
        version: metadata?.version ?? null,
        homepage: metadata?.homepage ?? null,
        iconUrl: metadata?.iconUrl ?? null,
        capabilities: [],
        commandHint: null,
        totalSessions: 0,
        activeSessions: 0,
        attentionSessions: 0,
      });
    }

    for (const session of filteredSessions) {
      const normalizedAgent = normalizeAgentName(session.metadata["agent"] ?? "");
      const agentName = normalizedAgent || "unassigned";
      const canonical = KNOWN_AGENT_ID_BY_LAUNCH[agentName] ?? agentName;
      const existing = map.get(canonical);
      const metadata = availableAgentMetadata.get(agentName) ?? availableAgentMetadata.get(KNOWN_AGENT_LAUNCH_BY_ID[agentName] ?? "");
      if (!existing) {
        map.set(canonical, {
          name: canonical,
          label: KNOWN_AGENT_BY_ID[canonical] ?? canonical,
          launchName: agentName,
          known: false,
          installed: discoveredAgentOptions.includes(agentName),
          description: metadata?.description ?? "Agent not currently discovered",
          version: metadata?.version ?? null,
          homepage: metadata?.homepage ?? null,
          iconUrl: metadata?.iconUrl ?? null,
          capabilities: [],
          commandHint: null,
          totalSessions: 1,
          activeSessions: 0,
          attentionSessions: 0,
        });
      } else {
        existing.totalSessions += 1;
      }

      const bucket = map.get(canonical) ?? null;
      if (!bucket) continue;

      if (!TERMINAL_STATUSES.has(session.status)) {
        bucket.activeSessions += 1;
      }

      const level = getAttentionLevel(session);
      if (level === "respond" || level === "review" || level === "merge") {
        bucket.attentionSessions += 1;
      }
    }

    return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [filteredSessions, discoveredAgentOptions, availableAgentMetadata]);

  const sessionsByLane = useMemo(() => {
    const grouped: Record<AttentionGroup, DashboardSession[]> = {
      respond: [],
      review: [],
      merge: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of filteredSessions) {
      const lane = getAttentionLevel(session) as AttentionGroup;
      grouped[lane].push(session);
    }
    return grouped;
  }, [filteredSessions]);

  const cleanupCandidates = useMemo(
    () => filteredSessions.filter((s) => TERMINAL_STATUSES.has(s.status)),
    [filteredSessions],
  );

  const postSessionMessage = useCallback(async (sessionId: string, message: string): Promise<boolean> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
      return false;
    }
    return true;
  }, []);

  const postReviewFeedback = useCallback(async (sessionId: string, message: string): Promise<boolean> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to submit review feedback for ${sessionId}:`, await res.text());
      return false;
    }
    return true;
  }, []);

  const handleSend = async (sessionId: string, message: string) => {
    await postSessionMessage(sessionId, message);
  };

  const handleChatSend = async (sessionId: string) => {
    if (chatSendingSession !== null) return;
    const message = chatMessages[sessionId]?.trim();
    if (!message) return;
    setChatSendingSession(sessionId);
    setActionError(null);
    const ok = await postSessionMessage(sessionId, message);
    setChatSendingSession((current) => (current === sessionId ? null : current));
    if (!ok) {
      setActionError(`Failed to send chat message for session ${sessionId}.`);
      return;
    }
    setChatMessages((prev) => ({ ...prev, [sessionId]: "" }));
  };

  const handleReviewSend = async (sessionId: string) => {
    if (reviewSendingSession !== null) return;
    const draft = reviewMessages[sessionId]?.trim();
    if (!draft) return;
    setReviewSendingSession(sessionId);
    setActionError(null);
    const ok = await postReviewFeedback(sessionId, draft);
    setReviewSendingSession((current) => (current === sessionId ? null : current));
    if (!ok) {
      setActionError(`Failed to send review notes for session ${sessionId}.`);
      return;
    }
    setReviewMessages((prev) => ({ ...prev, [sessionId]: "" }));
  };

  const updateReviewDiffState = useCallback((
    sessionId: string,
    patch: Partial<ReviewDiffState>,
  ) => {
    setReviewDiffState((prev) => {
      const current = prev[sessionId] ?? EMPTY_REVIEW_DIFF;
      return {
        ...prev,
        [sessionId]: { ...current, ...patch },
      };
    });
  }, []);

  const handleLoadReviewDiff = useCallback(async (sessionId: string) => {
    updateReviewDiffState(sessionId, {
      loading: true,
      loaded: false,
      error: null,
    });

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diff`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to load review diff (${res.status})`);
      }

      const data = (await res.json()) as ReviewDiffResponse;
      if ("error" in data && typeof data.error === "string") {
        throw new Error(data.error);
      }

      const payload = data as ReviewDiffPayload;
      const files = Array.isArray(payload.files) ? payload.files : [];
      const untracked = Array.isArray(payload.untracked) ? payload.untracked : [];
      const hasDiff = payload.hasDiff || files.length > 0 || untracked.length > 0;

      setReviewDiffState((prev) => {
        const current = prev[sessionId] ?? EMPTY_REVIEW_DIFF;
        const firstFile = files[0]?.path ?? null;
        const nextSelected = firstFile !== null &&
          current.selectedFilePath &&
          files.some((file) => file.path === current.selectedFilePath)
          ? current.selectedFilePath
          : firstFile;

        return {
          ...prev,
          [sessionId]: {
            ...current,
            loading: false,
            loaded: true,
            hasDiff,
            source: payload.source,
            truncated: payload.truncated,
            files,
            untracked,
            generatedAt: payload.generatedAt,
            selectedFilePath: nextSelected,
            error: null,
          },
        };
      });
    } catch (err) {
      updateReviewDiffState(sessionId, {
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : "Failed to load diff",
      });
    }
  }, [updateReviewDiffState]);

  const applyQuickMessage = useCallback(
    (sessionId: string, kind: string, template: string) => {
      if (kind === "review") {
        setReviewMessages((prev) => {
          const current = prev[sessionId] ?? "";
          const next = current.trim().length === 0
            ? template
            : `${current.trim()}\n\n${template}`;
          return {
            ...prev,
            [sessionId]: next,
          };
        });
        return;
      }

      setChatMessages((prev) => {
        const current = prev[sessionId] ?? "";
        const next = current.trim().length === 0
          ? template
          : `${current.trim()}\n\n${template}`;
        return {
          ...prev,
          [sessionId]: next,
        };
      });
    },
    [],
  );

  const updateSessionChecksState = useCallback((sessionId: string, patch: Partial<SessionChecksState>) => {
    setSessionChecksState((prev) => {
      const current = prev[sessionId] ?? EMPTY_SESSION_CHECKS;
      return {
        ...prev,
        [sessionId]: { ...current, ...patch },
      };
    });
  }, []);

  const handleLoadSessionChecks = useCallback(async (sessionId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      updateSessionChecksState(sessionId, { loading: true, error: null });
    }

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/checks`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to load CI checks (${res.status})`);
      }

      const data = (await res.json()) as CIChecksPayload;
      updateSessionChecksState(sessionId, {
        loading: false,
        loaded: true,
        ciStatus: data.ciStatus,
        checks: Array.isArray(data.checks) ? data.checks : [],
        source: data.source,
        generatedAt: data.generatedAt,
        error: null,
      });
    } catch (err) {
      updateSessionChecksState(sessionId, {
        loading: false,
        loaded: false,
        source: "not-loaded",
        generatedAt: "",
        error: err instanceof Error ? err.message : "Failed to load CI checks",
      });
    }
  }, [updateSessionChecksState]);

  useEffect(() => {
    if (trackedSessionIds.length === 0) return;
    let canceled = false;

    const sessionIds = trackedSessionIds;
    const shouldRefresh = (sessionId: string) => {
      const state = sessionChecksState[sessionId];
      if (!state) {
        return true;
      }
      if (!state.loaded && !state.loading) {
        return true;
      }
      if (state.error) {
        return true;
      }
      if (state.loading) {
        return false;
      }
      if (!state.generatedAt) {
        return true;
      }
      const last = Date.parse(state.generatedAt);
      if (Number.isNaN(last)) {
        return true;
      }
      const refreshWindow = state.ciStatus === "pending" ? CI_PENDING_REFRESH_MS : CI_AUTO_REFRESH_MS;
      return Date.now() - last > refreshWindow;
    };

    const refresh = async () => {
      if (canceled) return;
      const toRefresh = sessionIds.filter((sessionId) => shouldRefresh(sessionId));
      if (toRefresh.length === 0) {
        return;
      }
      await Promise.all(toRefresh.map((sessionId) => handleLoadSessionChecks(sessionId, { silent: true })));
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, CI_PENDING_REFRESH_MS);

    return () => {
      canceled = true;
      clearInterval(interval);
    };
  }, [trackedSessionIds.join(","), sessionChecksState, handleLoadSessionChecks]);

  useEffect(() => {
    if (dashboardTab !== "review") {
      for (const sessionId of Object.keys(reviewDiffLoadTimersRef.current)) {
        clearTimeout(reviewDiffLoadTimersRef.current[sessionId]);
        delete reviewDiffLoadTimersRef.current[sessionId];
      }
      return;
    }

    const activeSessionIds = new Set(reviewSessions.map((session) => session.id));
    for (const [sessionId, timer] of Object.entries(reviewDiffLoadTimersRef.current)) {
      if (!activeSessionIds.has(sessionId)) {
        clearTimeout(timer);
        delete reviewDiffLoadTimersRef.current[sessionId];
      }
    }

    for (const session of reviewSessions) {
      const state = reviewDiffState[session.id] ?? EMPTY_REVIEW_DIFF;
      if (state.loaded || state.loading) continue;
      if (reviewDiffLoadTimersRef.current[session.id]) continue;

      reviewDiffLoadTimersRef.current[session.id] = setTimeout(() => {
        void handleLoadReviewDiff(session.id)
          .catch(() => {})
          .finally(() => {
            delete reviewDiffLoadTimersRef.current[session.id];
          });
      }, DIFF_AUTO_LOAD_DELAY_MS);
    }

    return () => {
      for (const [sessionId, timer] of Object.entries(reviewDiffLoadTimersRef.current)) {
        clearTimeout(timer);
        delete reviewDiffLoadTimersRef.current[sessionId];
      }
    };
  }, [dashboardTab, reviewSessions, reviewDiffState, handleLoadReviewDiff]);

  const executeKill = useCallback(async (sessionId: string): Promise<{ ok: boolean; reason?: string }> => {
    setBusySessionId(sessionId);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 404) {
        const detail = await res.text();
        return {
          ok: false,
          reason: detail || `Request failed with ${res.status}`,
        };
      }

      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      return { ok: false, reason: msg };
    } finally {
      setBusySessionId((current) => (current === sessionId ? null : current));
    }
  }, []);

  const executeRestore = useCallback(async (sessionId: string): Promise<{ ok: boolean; reason?: string }> => {
    setBusySessionId(sessionId);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
        method: "POST",
      });
      if (!res.ok) {
        const detail = await res.text();
        return {
          ok: false,
          reason: detail || `Request failed with ${res.status}`,
        };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      return { ok: false, reason: msg };
    } finally {
      setBusySessionId((current) => (current === sessionId ? null : current));
    }
  }, []);

  const openCleanupDialog = (
    sessionIds: string[],
    kind: CleanupDialogKind,
    action: CleanupAction,
    title: string,
    message: string,
    isTerminalSession = false,
  ) => {
    if (busySessionId || bulkBusy || cleanupDialog.open) return;
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueIds.length === 0) return;
    setCleanupDialog({
      open: true,
      kind,
      action,
      title,
      message,
      sessionIds: uniqueIds,
      isTerminalSession,
    });
  };

  const closeCleanupDialog = () => {
    setCleanupDialog((current) => ({ ...current, open: false }));
  };

  const confirmCleanup = async () => {
    const current = cleanupDialog;
    if (!current.open || current.sessionIds.length === 0) {
      closeCleanupDialog();
      return;
    }
    if (current.kind === "single") {
      const sessionId = current.sessionIds[0]!;
      if (!sessionId || busySessionId || bulkBusy) return;
      setActionError(null);
      const result = current.action === "restore"
        ? await executeRestore(sessionId)
        : await executeKill(sessionId);
      if (!result.ok) {
        const reason = result.reason ?? "Unknown error";
        logActionError(sessionId, reason, current.action);
      }
      closeCleanupDialog();
      return;
    }

    if (current.kind === "terminal-bulk") {
      if (bulkBusy || busySessionId) return;
      setActionError(null);
      setBulkBusy(true);
      const failures: string[] = [];
      for (const sessionId of current.sessionIds) {
        const result = await executeKill(sessionId);
        if (!result.ok) {
          failures.push(`${sessionId}: ${result.reason ?? "Unknown error"}`);
        }
      }
      setBulkBusy(false);
      setCleanupDialog((current) => ({ ...current, open: false }));

      if (failures.length > 0) {
        setActionError(`Cleanup completed with ${failures.length} failure(s). ${failures[0]}`);
        return;
      }
      setActionError(null);
    }
  };

  const handleCleanupTerminal = async () => {
    if (busySessionId || bulkBusy) return;
    if (cleanupCandidates.length === 0) return;

    const ids = [...new Set(cleanupCandidates.map((s) => s.id))];
    const noun = ids.length === 1 ? "session" : "sessions";
    openCleanupDialog(
      ids,
      "terminal-bulk",
      "cleanup",
      `Clean up ${ids.length} terminal ${noun}`,
      `Clean up all terminal sessions in the current view (${ids.length} ${noun}).`,
    );
  };

  const handleKill = (sessionId: string, isTerminalSession = false) => {
    if (busySessionId || bulkBusy) return;
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    openCleanupDialog(
      [normalizedSessionId],
      "single",
      isTerminalSession ? "cleanup" : "kill",
      `${isTerminalSession ? "Cleanup" : "Kill"} session`,
      `${isTerminalSession ? "Clean up" : "Kill"} ${normalizedSessionId}.`,
      isTerminalSession,
    );
  };

  const handleRestore = (sessionId: string) => {
    if (busySessionId || bulkBusy) return;
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    openCleanupDialog(
      [normalizedSessionId],
      "single",
      "restore",
      "Restore session",
      `Restore ${normalizedSessionId}.`,
      false,
    );
  };

  const logActionError = (sessionId: string, reason: string, action: CleanupAction) => {
    const actionLabel = action === "restore"
      ? "restore"
      : action === "kill"
        ? "kill"
        : "cleanup";
    setActionError(`Unable to ${actionLabel} session ${sessionId}: ${reason}`);
    console.error(`Failed to ${actionLabel} session ${sessionId}:`, reason);
  };
  const handleLaunchSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLaunchMessage(null);

    if (launchLoading) return;

    const projectId = launchProjectId || (configProjects[0]?.id ?? "");
    if (!projectId) {
      setLaunchMessage("Select a project to launch a session.");
      return;
    }
    if (!launchPrompt.trim()) {
      setLaunchMessage("Session prompt is required.");
      return;
    }
    const normalizedAgent = normalizeLaunchAgent(launchAgent).trim();
    const loweredLaunchAgent = launchAgent.trim().toLowerCase();
    const resolvedAgent = loweredLaunchAgent === "auto" || loweredLaunchAgent === "custom" || !normalizedAgent
      ? undefined
      : normalizedAgent;

    setLaunchLoading(true);

    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          issueId: launchIssueId.trim().length > 0 ? launchIssueId.trim() : undefined,
          prompt: launchPrompt.trim(),
          agent: resolvedAgent,
          model: launchModel.trim().length > 0 ? launchModel.trim() : undefined,
          profile: launchProfile.trim().length > 0 ? launchProfile.trim() : undefined,
          branch: launchBranch.trim().length > 0 ? launchBranch.trim() : undefined,
          baseBranch:
            launchBaseBranch.trim().length > 0 ? launchBaseBranch.trim() : undefined,
        }),
      });

      if (!res.ok) {
        const rawDetail = await res.text();
        let detail = rawDetail;
        if (rawDetail) {
          try {
            const data = JSON.parse(rawDetail) as { error?: string };
            if (typeof data.error === "string" && data.error.length > 0) {
              detail = data.error;
            }
          } catch {
            // keep plain-text response as-is
          }
        }
        const isCloneLimit = (typeof detail === "string" && detail.includes("already has") && detail.includes("active sessions"));
        setLaunchMessage(
          isCloneLimit
            ? `${detail} (configured by maxSessionsPerProject; increase in your CONDUCTOR config)`
            : detail || `Failed to launch session (${res.status})`,
        );
        return;
      }

      setLaunchMessage("Session launched. Refreshing dashboard...");
      setLaunchIssueId("");
      setLaunchPrompt("");
      setLaunchModel("");
      setLaunchProfile("");
      setLaunchBranch("");
      setLaunchBaseBranch("");
      void pollSessions();
    } catch (err) {
      setLaunchMessage(err instanceof Error ? err.message : "Failed to launch session");
    } finally {
      setLaunchLoading(false);
    }
  };

  useEffect(() => {
    if (!commandOpen) return;
    const id = window.setTimeout(() => {
      commandInputRef.current?.focus();
    }, 20);
    return () => window.clearTimeout(id);
  }, [commandOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = Boolean(
        target &&
          (target.closest("input, textarea, select") ||
            target.isContentEditable),
      );

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        setCommandQuery("");
        return;
      }

      if (event.key === "Escape" && commandOpen) {
        event.preventDefault();
        setCommandOpen(false);
        return;
      }

      if (event.key === "Escape" && cleanupDialog.open) {
        event.preventDefault();
        closeCleanupDialog();
        return;
      }

      if (!isTypingTarget && event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen, cleanupDialog.open]);

  type CommandAction = { id: string; label: string; hint?: string; run: () => void };
  const commandActions: CommandAction[] = useMemo(() => {
    return [
      {
        id: "toggle-theme",
        label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
        hint: "Appearance",
        run: () => toggleTheme(),
      },
      {
        id: "toggle-view",
        label: viewMode === "grid" ? "Switch to lane view" : "Switch to grid view",
        hint: "Layout",
        run: () => setViewMode((v) => (v === "grid" ? "lanes" : "grid")),
      },
      {
        id: "refresh",
        label: "Refresh sessions now",
        hint: "Live data",
        run: () => {
          void pollSessions();
        },
      },
      {
        id: "focus-attention",
        label: attentionOnly ? "Show all sessions" : "Focus needs attention",
        hint: "Filtering",
        run: () => setAttentionOnly((v) => !v),
      },
      {
        id: "clear-filters",
        label: "Clear filters",
        hint: "Filtering",
        run: () => {
          setSearch("");
          setStatusFilter("all");
          setAgentFilter("all");
          setAttentionOnly(false);
          setSortMode("recent");
        },
      },
      {
        id: "cleanup",
        label: `Cleanup terminal sessions (${cleanupCandidates.length})`,
        hint: "Agent control",
        run: () => {
          void handleCleanupTerminal();
        },
      },
    ];
  }, [theme, toggleTheme, viewMode, pollSessions, attentionOnly, cleanupCandidates.length, handleCleanupTerminal]);

  const visibleCommandActions = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (query.length === 0) return commandActions;
    return commandActions.filter((action) => {
      const text = `${action.label} ${action.hint ?? ""}`.toLowerCase();
      return text.includes(query);
    });
  }, [commandActions, commandQuery]);

  const visibleTabSessions = useMemo(() => {
    if (dashboardTab === "chat") return chatSessions;
    if (dashboardTab === "review") return reviewSessions;
    return filteredSessions;
  }, [chatSessions, reviewSessions, filteredSessions, dashboardTab]);

  const visibleAgentRoster = useMemo(() => {
    if (dashboardTab !== "agents") return agentRoster;
    const query = search.trim().toLowerCase();
    if (!query) return agentRoster;
    return agentRoster.filter((agent) => {
      const haystack = [agent.label, agent.name, agent.launchName, agent.description ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [agentRoster, dashboardTab, search]);

  const visibleKnownAgents = useMemo(
    () => visibleAgentRoster.filter((agent) => agent.known),
    [visibleAgentRoster],
  );
  const visibleDiscoveredAgents = useMemo(
    () => visibleAgentRoster.filter((agent) => !agent.known),
    [visibleAgentRoster],
  );

  const searchPlaceholder = dashboardTab === "agents"
    ? "Search agents..."
    : dashboardTab === "chat"
      ? "Search sessions needing agent response..."
      : dashboardTab === "review"
        ? "Search sessions or changed files..."
        : "Search sessions, issues, branches, agents...";

  const totalAgentCatalogCount = Math.max(
    visibleAgentRoster.length,
    availableAgents.length,
    discoveredAgentOptions.length,
    KNOWN_AGENTS.length,
  );
  const cleanupDialogLabel = cleanupDialog.kind === "terminal-bulk"
    ? `Cleanup ${cleanupDialog.sessionIds.length} session${cleanupDialog.sessionIds.length === 1 ? "" : "s"}`
    : cleanupDialog.action === "restore"
      ? "Restore session"
      : cleanupDialog.isTerminalSession
        ? "Cleanup session"
        : "Kill session";
  const cleanupDialogBusy = cleanupDialog.kind === "terminal-bulk"
    ? bulkBusy
    : Boolean(busySessionId) || bulkBusy;

  const handleOpenTerminal = useCallback((sessionId: string) => {
    router.push(`/sessions/${encodeURIComponent(sessionId)}?tab=terminal`);
  }, [router]);

  useEffect(() => {
    if (dashboardTab !== "chat" && dashboardTab !== "review") return;
    if (statusFilter !== "all") {
      setStatusFilter("all");
    }
    if (attentionOnly) {
      setAttentionOnly(false);
    }
    if (agentFilter !== "all") {
      setAgentFilter("all");
    }
    if (sortMode !== "recent") {
      setSortMode("recent");
    }
  }, [agentFilter, attentionOnly, dashboardTab, sortMode, statusFilter]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`shrink-0 border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] flex flex-col transition-all duration-200 ${
          sidebarOpen ? "w-72" : "w-0 overflow-hidden border-r-0"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)] tracking-tight">
            Conductor
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          <div className="mb-1 px-2 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Projects
          </div>

          {/* All sessions */}
          <button
            onClick={() => setActiveProject(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${
              activeProject === null
                ? "bg-[var(--color-sidebar-active)] text-[var(--color-accent)] font-medium"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
              <path d="M1.5 1.75V13.5h13.25a.75.75 0 010 1.5H.75a.75.75 0 01-.75-.75V1.75a.75.75 0 011.5 0zm14.28 2.53l-5.25 5.25a.75.75 0 01-1.06 0L7 7.06 4.28 9.78a.75.75 0 01-1.06-1.06l3.25-3.25a.75.75 0 011.06 0L10 7.94l4.72-4.72a.75.75 0 111.06 1.06z" />
            </svg>
            <span>All Sessions</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-muted)] tabular-nums">
              {sessions.length}
            </span>
          </button>

          {/* Project list */}
          {projects.map((project) => {
            const boardDirHasPath = project.boardDir.includes("/");
            const inferredBoardFile = project.boardDir.endsWith(".md")
              ? (boardDirHasPath ? project.boardDir : `projects/${project.boardDir}`)
              : (boardDirHasPath
                ? `${project.boardDir}/CONDUCTOR.md`
                : `projects/${project.boardDir}/CONDUCTOR.md`);
            const obsidianFile = project.boardFile ?? inferredBoardFile;
            const obsidianUrl = `obsidian://open?vault=workspace&file=${encodeURIComponent(obsidianFile)}`;
            const githubUrl = project.repo ? `https://github.com/${project.repo}` : null;
            return (
              <div key={project.id} className="group relative flex w-full items-center">
                <button
                  onClick={() => setActiveProject(activeProject === project.id ? null : project.id)}
                  className={`mr-2 flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                    activeProject === project.id
                      ? "bg-[var(--color-sidebar-active)] text-[var(--color-accent)] font-medium"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]"
                  }`}
                >
                  <ProjectFavicon
                    projectId={project.id}
                    repo={project.repo}
                    iconUrl={project.iconUrl}
                  />
                  <span className="truncate">{project.id}</span>
                  <span className="ml-auto text-[11px] text-[var(--color-text-muted)] tabular-nums">
                    {project.count}
                  </span>
                </button>
                {/* Quick-action icons — always visible */}
                <div className="project-action-icons mr-2 flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    title="Open board in Obsidian"
                    style={{
                      color: "var(--color-accent-violet)",
                      background: "transparent",
                      outline: "none",
                      boxShadow: "none",
                      border: "none",
                      padding: 0,
                    }}
                    onClick={() => {
                      window.location.href = obsidianUrl;
                    }}
                    className="project-action-icon inline-flex cursor-pointer items-center justify-center p-1"
                    aria-label="Open board in Obsidian"
                  >
                    <ObsidianLogo className="h-[18px] w-[18px]" fillColor="var(--color-accent-violet)" />
                  </button>
                  {githubUrl && (
                    <button
                      type="button"
                      title="Open repo on GitHub"
                      style={{
                        color: "var(--color-text-muted)",
                        background: "transparent",
                        outline: "none",
                        boxShadow: "none",
                        border: "none",
                        padding: 0,
                      }}
                      onClick={() => {
                        window.open(githubUrl, "_blank", "noopener,noreferrer");
                      }}
                      className="project-action-icon inline-flex cursor-pointer items-center justify-center p-1"
                      aria-label="Open repo on GitHub"
                    >
                      <GitHubLogo className="h-[18px] w-[18px]" fillColor="var(--color-text-muted)" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="px-2 pb-3">
          <div className="px-2 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Available Agents
          </div>
          {availableAgents.length === 0 ? (
            <div className="px-2 text-[11px] text-[var(--color-text-muted)]">
              Loading from /api/agents...
            </div>
          ) : (
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {availableAgents.map((agent) => (
                <button
                  key={agent.name}
                  type="button"
                  onClick={() => setLaunchAgent(agent.name)}
                  className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-sidebar-hover)]"
                >
                  <div className="truncate text-[11px] font-medium text-[var(--color-text-secondary)]">
                    {agent.name}
                  </div>
                  <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                    {agent.description ?? "agent plugin"}
                    {agent.version ? ` (v${agent.version})` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-6 py-3">
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)] transition-colors"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 2.75A.75.75 0 011.75 2h12.5a.75.75 0 010 1.5H1.75A.75.75 0 011 2.75zm0 5A.75.75 0 011.75 7h12.5a.75.75 0 010 1.5H1.75A.75.75 0 011 7.75zM1.75 12a.75.75 0 000 1.5h12.5a.75.75 0 000-1.5H1.75z" />
            </svg>
          </button>

          <h1 className="text-[15px] font-semibold text-[var(--color-text-primary)] tracking-tight">
            {activeProject ? activeProject : "Dashboard"}
          </h1>

          <div className="ml-2 flex items-center gap-1 rounded-md bg-[var(--color-bg-elevated)] p-0.5">
            {TAB_DEFINITIONS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setDashboardTab(tab.id)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                  dashboardTab === tab.id
                    ? "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] shadow-[0_1px_0_rgba(255,255,255,0.12)_inset]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-secondary)]"
                }`}
                title={tab.subtitle}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected
                  ? "bg-[var(--color-status-ready)] animate-[pulse_3s_ease-in-out_infinite]"
                  : "bg-[var(--color-status-error)]"
              }`}
            />
            <span className="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider">
              {connected ? "Live" : "Offline"}
            </span>
          </div>

          <div className="flex-1" />

          {/* Stats pills */}
          <div className="hidden items-center gap-2 sm:flex">
            <StatPill label="Sessions" value={stats.totalSessions} />
            {stats.workingSessions > 0 && (
              <StatPill
                label="Working"
                value={stats.workingSessions}
                color="var(--color-status-working)"
              />
            )}
            {stats.openPRs > 0 && (
              <StatPill
                label="PRs"
                value={stats.openPRs}
                color="var(--color-accent-violet)"
              />
            )}
            {stats.needsAttention > 0 && (
              <StatPill
                label="Attention"
                value={stats.needsAttention}
                color="var(--color-status-attention)"
              />
            )}
          </div>

          <button
            onClick={() => {
              setCommandOpen(true);
              setCommandQuery("");
            }}
            className="hidden items-center gap-2 rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)] sm:flex"
            title="Open command bar"
          >
            <span>Command</span>
            <kbd className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-1 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
              Ctrl/Cmd+K
            </kbd>
          </button>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="rounded-md border border-[var(--color-border-default)] p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)]"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0V.75A.75.75 0 018 0zm5.657 2.343a.75.75 0 010 1.06l-1.06 1.061a.75.75 0 11-1.061-1.06l1.06-1.061a.75.75 0 011.061 0zM16 8a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0116 8zm-2.343 5.657a.75.75 0 01-1.06 0l-1.061-1.06a.75.75 0 111.06-1.061l1.061 1.06a.75.75 0 010 1.061zM8 16a.75.75 0 01-.75-.75v-1.5a.75.75 0 011.5 0v1.5A.75.75 0 018 16zM2.343 13.657a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.061a.75.75 0 01-1.061 0zM0 8a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5H.75A.75.75 0 010 8zm2.343-5.657a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061L2.343 3.404a.75.75 0 010-1.061z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z" />
              </svg>
            )}
          </button>
        </header>
        {actionError && (
          <div className="mx-6 mt-3 rounded-md border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.12)] px-3 py-2 text-[11px] text-[var(--color-status-error)]">
            {actionError}
          </div>
        )}
        {launchMessage && (
          <div className="mx-6 mt-2 rounded-md border border-[rgba(59,130,246,0.3)] bg-[rgba(59,130,246,0.1)] px-3 py-2 text-[11px] text-[var(--color-accent)]">
            {launchMessage}
          </div>
        )}

        <section className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-6 py-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Launch Session
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                Session cap note: each project is limited by <code>maxSessionsPerProject</code> (default 5). If you hit the limit, kill/cleanup old sessions first or increase it in your Conductor config.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsLaunchCollapsed((current) => !current)}
              className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]"
            >
              {isLaunchCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          {!isLaunchCollapsed && (
            <form
              className="space-y-2"
              onSubmit={(event) => void handleLaunchSession(event)}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <select
                  value={launchProjectId}
                  onChange={(event) => setLaunchProjectId(event.target.value)}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
                >
                  {configProjects.length === 0 && <option value="">No projects</option>}
                  {configProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.id}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={launchIssueId}
                  onChange={(event) => setLaunchIssueId(event.target.value)}
                  placeholder="Issue ID (optional)"
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                />
                <select
                  value={launchAgent}
                  onChange={(event) => setLaunchAgent(event.target.value)}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="auto">Auto (project default)</option>
                  {launchAgentOptions.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                  <option value="custom">Custom agent</option>
                </select>
                <input
                  list="launch-agent-list"
                  type="text"
                  value={launchAgent}
                  onChange={(event) => setLaunchAgent(event.target.value)}
                  placeholder="or type a custom agent name"
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                />
                <datalist id="launch-agent-list">
                  <option value="auto" />
                  {launchAgentOptions.map((agent) => (
                    <option key={`agent-list-${agent}`} value={agent} />
                  ))}
                </datalist>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <input
                  type="text"
                  value={launchModel}
                  onChange={(event) => setLaunchModel(event.target.value)}
                  placeholder="Model (optional)"
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                />
                <input
                  type="text"
                  value={launchProfile}
                  onChange={(event) => setLaunchProfile(event.target.value)}
                  placeholder="Profile (optional)"
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                />
                <div className="grid gap-2 sm:grid-cols-2 sm:col-span-1">
                  <input
                    type="text"
                    value={launchBranch}
                    onChange={(event) => setLaunchBranch(event.target.value)}
                    placeholder="Branch (optional)"
                    className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  />
                  <input
                    type="text"
                    value={launchBaseBranch}
                    onChange={(event) => setLaunchBaseBranch(event.target.value)}
                    placeholder="Base branch (optional)"
                    className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  />
                </div>
              </div>
              <textarea
                value={launchPrompt}
                onChange={(event) => setLaunchPrompt(event.target.value)}
                rows={2}
                placeholder="Prompt for this task"
                className="min-h-[74px] w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={launchLoading}
                  className="rounded-md border border-[var(--color-accent)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-subtle)] disabled:opacity-50"
                >
                  {launchLoading ? "Launching..." : "Launch Session"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLaunchPrompt("");
                    setLaunchIssueId("");
                    setLaunchModel("");
                    setLaunchProfile("");
                    setLaunchBranch("");
                    setLaunchBaseBranch("");
                    setLaunchMessage(null);
                  }}
                  className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]"
                >
                  Reset
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-6 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            {dashboardTab !== "agents" && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
                  disabled={dashboardTab === "chat" || dashboardTab === "review"}
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active only</option>
                  <option value="terminal">Terminal only</option>
                  <option value="attention">Needs attention</option>
                </select>

                <select
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
                  disabled={dashboardTab === "chat" || dashboardTab === "review"}
                >
                  <option value="all">All agents</option>
                  {discoveredAgentOptions.map((agent) => (
                    <option key={agent} value={agent}>{agent}</option>
                  ))}
                </select>

                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
                  disabled={dashboardTab === "chat" || dashboardTab === "review"}
                >
                  <option value="recent">Recent activity</option>
                  <option value="oldest">Oldest activity</option>
                  <option value="attention">Attention priority</option>
                  <option value="cost">Cost high to low</option>
                </select>

                <button
                  onClick={() => setAttentionOnly((v) => !v)}
                  disabled={dashboardTab === "chat" || dashboardTab === "review"}
                  className={`rounded-md border px-2.5 py-2 text-[11px] font-medium transition-colors ${
                    attentionOnly
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                      : "border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  Attention only
                </button>

                <button
                  onClick={() => setViewMode((v) => (v === "grid" ? "lanes" : "grid"))}
                  className="rounded-md border border-[var(--color-border-default)] px-2.5 py-2 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)]"
                  disabled={dashboardTab === "chat" || dashboardTab === "review"}
                >
                  {viewMode === "grid" ? "Lane View" : "Grid View"}
                </button>

                <button
                  onClick={() => void handleCleanupTerminal()}
                  disabled={cleanupCandidates.length === 0 || bulkBusy || busySessionId !== null || dashboardTab === "chat" || dashboardTab === "review"}
                  className="rounded-md border border-[rgba(239,68,68,0.28)] px-2.5 py-2 text-[11px] font-medium text-[var(--color-status-error)] transition-colors hover:bg-[rgba(239,68,68,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
                  title={cleanupCandidates.length === 0 ? "No terminal sessions in current view" : "Clean up terminal sessions in current view"}
                >
                  {bulkBusy ? "Cleaning..." : `Cleanup (${cleanupCandidates.length})`}
                </button>
              </div>
            )}
          </div>

          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            Showing {dashboardTab === "agents"
              ? visibleAgentRoster.length
              : visibleTabSessions.length} {dashboardTab === "agents" ? "agents" : "sessions"} of {
              dashboardTab === "agents"
                ? totalAgentCatalogCount
                : sessions.length
            } {dashboardTab === "agents" ? "agents" : "sessions"}
            {activeProject ? ` in ${activeProject}` : ""}.
          </div>
        </section>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6">
          {dashboardTab === "agents" && (
            <div className="space-y-4">
              {visibleAgentRoster.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-6 text-[11px] text-[var(--color-text-muted)]">
                  No agents discovered.
                </div>
              ) : (
                <>
                  {visibleKnownAgents.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                        Known agents
                      </h3>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {visibleKnownAgents.map((agent) => {
                          const known = getKnownAgent(agent.name) ?? getKnownAgent(agent.launchName);
                          const agentIconSource: AgentIconSeed = {
                            label: agent.label,
                            launchName: agent.launchName,
                            homepage: agent.homepage,
                            iconUrl: agent.iconUrl,
                          };
                          const capabilities = known?.capabilities ?? agent.capabilities ?? [];
                          return (
                            <article
                              key={agent.name}
                              className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
                            >
                              <div className="mb-3 flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="mb-1 flex items-center gap-2">
                                    <AgentIcon agent={agentIconSource} className="h-6 w-6" />
                                    <h2 className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
                                      {agent.label}
                                    </h2>
                                    <span className="rounded-full bg-[rgba(59,130,246,0.12)] px-2 py-0.5 text-[9px] text-[var(--color-accent)]">
                                      official
                                    </span>
                                  </div>
                                  <p className="truncate text-[10px] text-[var(--color-text-muted)]">
                                    launch: {agent.launchName} ·
                                    version {agent.version ?? "n/a"} ·
                                    source {agent.installed ? "installed" : "not-installed"}
                                  </p>
                                </div>
                              </div>
                              <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                                {agent.description ?? "Agent plugin metadata not available."}
                              </p>
                              {capabilities.length > 0 && (
                                <div className="mb-3 flex flex-wrap gap-1">
                                  {capabilities.map((capability) => (
                                    <span
                                      key={`${agent.name}-${capability}`}
                                      className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]"
                                    >
                                      {capability}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {known && !agent.installed && known.installHint && (
                                <p className="text-[10px] text-[var(--color-text-muted)] mb-2">
                                  Install: <span className="font-mono text-[var(--color-text-secondary)]">{known.installHint}</span>
                                </p>
                              )}
                              {agent.homepage && (
                                <a
                                  href={agent.homepage}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="mb-3 inline-block text-[10px] text-[var(--color-accent)] hover:underline"
                                >
                                  Documentation ↗
                                </a>
                              )}
                              <div className="grid grid-cols-3 gap-2 text-[11px] mb-3">
                                <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-2">
                                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Sessions</div>
                                  <div className="text-[14px] font-semibold text-[var(--color-text-primary)]">{agent.totalSessions}</div>
                                </div>
                                <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-2">
                                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Active</div>
                                  <div className="text-[14px] font-semibold text-[var(--color-text-primary)]">{agent.activeSessions}</div>
                                </div>
                                <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-2">
                                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Needs attention</div>
                                  <div className="text-[14px] font-semibold text-[var(--color-status-error)]">{agent.attentionSessions}</div>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-2 text-[11px]">
                                <button
                                  onClick={() => setLaunchAgent(agent.launchName)}
                                  disabled={!agent.installed}
                                  className="rounded-md bg-[var(--color-accent)] px-2 py-1.5 font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {agent.installed ? "Launch now" : "Not installed"}
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const command = agent.commandHint ?? `conductor --agent ${agent.launchName}`;
                                    try {
                                      await navigator.clipboard.writeText(command);
                                      setLaunchMessage(`Copied launch command: ${command}`);
                                      setActionError(null);
                                    } catch {
                                      setActionError("Clipboard write failed.");
                                    }
                                  }}
                                  className="rounded-md border border-[var(--color-border-default)] px-2 py-1.5 text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)]"
                                >
                                  Copy launch command
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {visibleDiscoveredAgents.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                        Discovered agents
                      </h3>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {visibleDiscoveredAgents.map((agent) => {
                          const agentIconSource: AgentIconSeed = {
                            label: agent.label,
                            launchName: agent.launchName,
                            homepage: agent.homepage,
                            iconUrl: agent.iconUrl,
                          };
                          return (
                          <article
                            key={agent.name}
                            className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
                          >
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex items-center gap-2">
                                  <AgentIcon agent={agentIconSource} className="h-6 w-6" />
                                  <h2 className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
                                  {agent.label}
                                  </h2>
                                  <span className="rounded-full bg-[rgba(239,68,68,0.12)] px-2 py-0.5 text-[9px] text-[var(--color-status-error)]">
                                    {agent.version ? `v${agent.version}` : "unknown"}
                                  </span>
                                </div>
                                <p className="truncate text-[10px] text-[var(--color-text-muted)]">
                                  launch: {agent.launchName} · source: detected runtime
                                </p>
                              </div>
                            </div>
                            <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                              {agent.description ?? "Agent plugin currently detected."}
                            </p>
                            <div className="grid grid-cols-3 gap-2 text-[11px] mb-3">
                              <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Sessions</div>
                                <div className="text-[14px] font-semibold text-[var(--color-text-primary)]">{agent.totalSessions}</div>
                              </div>
                              <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Active</div>
                                <div className="text-[14px] font-semibold text-[var(--color-text-primary)]">{agent.activeSessions}</div>
                              </div>
                              <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Needs attention</div>
                                <div className="text-[14px] font-semibold text-[var(--color-status-error)]">{agent.attentionSessions}</div>
                              </div>
                            </div>
                            <button
                              onClick={() => setLaunchAgent(agent.launchName)}
                              className="w-full rounded-md border border-[var(--color-border-default)] px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)]"
                            >
                              Use this agent for next launch
                            </button>
                          </article>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          )}

          <>
              {visibleTabSessions.length === 0 ? (
                <EmptyState />
              ) : dashboardTab === "overview" && viewMode === "lanes" ? (
                <div className="flex min-w-max gap-4">
                  {LANE_META.map((lane) => (
                    <LaneColumn
                      key={lane.id}
                      title={lane.title}
                      color={lane.color}
                      count={sessionsByLane[lane.id].length}
                    >
                      {sessionsByLane[lane.id].length === 0 ? (
                        <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-4 text-[11px] text-[var(--color-text-muted)]">
                          No sessions
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {sessionsByLane[lane.id].map((session) => (
                            <SessionCard
                              key={session.id}
                              session={session}
                              onSend={handleSend}
                              onKill={handleKill}
                              onRestore={handleRestore}
                              onOpenTerminal={handleOpenTerminal}
                              actionBusy={busySessionId === session.id || bulkBusy}
                            />
                          ))}
                        </div>
                      )}
                    </LaneColumn>
                  ))}
                </div>
              ) : dashboardTab === "overview" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {filteredSessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      onSend={handleSend}
                      onKill={handleKill}
                      onRestore={handleRestore}
                      onOpenTerminal={handleOpenTerminal}
                      actionBusy={busySessionId === session.id || bulkBusy}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {visibleTabSessions.map((session) => {
                    const reviewDiff = reviewDiffState[session.id] ?? EMPTY_REVIEW_DIFF;
                    const activeChecks = sessionChecksState[session.id] ?? EMPTY_SESSION_CHECKS;
                    const isTrackableForChecks = Boolean(session.pr && session.pr.number > 0);
                    const quickActions = dashboardTab === "review" ? REVIEW_QUICK_ACTIONS : CHAT_QUICK_ACTIONS;
                    const currentMessage = dashboardTab === "review"
                      ? reviewMessages[session.id] ?? ""
                      : chatMessages[session.id] ?? "";
                    const fileSearchValue = reviewDiff.fileSearch.trim().toLowerCase();
                    const lineSearchValue = reviewDiff.search.trim().toLowerCase();
                    const filteredFiles = reviewDiff.files.filter((file) => {
                      return fileSearchValue.length === 0 || file.path.toLowerCase().includes(fileSearchValue);
                    });
                    const selectedFile = filteredFiles.find((file) => file.path === reviewDiff.selectedFilePath)
                      ?? filteredFiles[0];
                    const visibleLines = selectedFile
                      ? selectedFile.lines.filter((line) => {
                        if (lineSearchValue.length === 0) return true;
                        const query = lineSearchValue;
                        if (line.text.toLowerCase().includes(query)) return true;
                        if (line.oldLine != null && `${line.oldLine}`.includes(query)) return true;
                        if (line.newLine != null && `${line.newLine}`.includes(query)) return true;
                        return false;
                      })
                      : [];

                      return (
                      <article key={session.id} className="overflow-hidden rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-3">
                        <SessionCard
                          session={session}
                          onSend={handleSend}
                          onKill={handleKill}
                          onRestore={handleRestore}
                          onOpenTerminal={handleOpenTerminal}
                          actionBusy={busySessionId === session.id || bulkBusy}
                        />
                        <div className="mt-3 space-y-3 border-t border-[var(--color-border-subtle)] pt-3">
                          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[linear-gradient(to_right,_rgba(59,130,246,0.1),_rgba(99,102,241,0.08))] p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                                CI checks
                              </span>
                              {isTrackableForChecks ? (
                                <>
                                  <span
                                    className="rounded-full px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                                    style={{ background: getCIBadgeStyle(activeChecks.ciStatus).color }}
                                  >
                                    {getCIBadgeStyle(activeChecks.ciStatus).label}
                                  </span>
                                  {activeChecks.source !== "not-loaded" ? (
                                    <span className="rounded-full border border-[rgba(148,163,184,0.5)] px-2 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                                      {activeChecks.source}
                                    </span>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => void handleLoadSessionChecks(session.id)}
                                    disabled={activeChecks.loading}
                                    className="rounded-md border border-[var(--color-accent)] px-2 py-1 text-[10px] font-medium text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {activeChecks.loaded
                                      ? (activeChecks.loading ? "Refreshing..." : "Refresh")
                                      : "Load checks"}
                                  </button>
                                </>
                              ) : null}
                              <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                                {activeChecks.generatedAt ? formatGeneratedAt(activeChecks.generatedAt) : "not checked"}
                              </span>
                            </div>
                            {activeChecks.loading && !activeChecks.loaded && (
                              <div className="rounded-md bg-[var(--color-bg-subtle)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
                                Loading CI checks...
                              </div>
                            )}
                            {activeChecks.error && (
                              <div className="rounded-md border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.12)] px-2.5 py-2 text-[10px] text-[var(--color-status-error)]">
                                {activeChecks.error}
                              </div>
                            )}
                            {activeChecks.loaded && activeChecks.checks.length === 0 && (
                              <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
                                No CI checks returned yet.
                              </div>
                            )}
                            {activeChecks.loaded && activeChecks.checks.length > 0 && (
                              <div className="space-y-1">
                                {activeChecks.checks.map((check) => {
                                  const checkBadge = getCIBadgeStyle(getCheckBadgeStatus(check.status));
                                  return (
                                    <div
                                      key={`${session.id}-${check.name}`}
                                      className="flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[10px]"
                                    >
                                      <span className={`h-1.5 w-1.5 rounded-full ${checkBadge.dot}`} />
                                      <span className="truncate text-[var(--color-text-secondary)]">{check.name}</span>
                                      <span className="ml-auto rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
                                        {check.status}
                                      </span>
                                      {check.url ? (
                                        <a
                                          href={check.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          title="Open check details"
                                          className="text-[9px] font-semibold text-[var(--color-accent)] hover:underline"
                                          onClick={(event) => event.stopPropagation()}
                                        >
                                          details
                                        </a>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          {dashboardTab === "review" && (
                            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-3">
                              <div className="mb-2 flex flex-wrap items-center gap-2">
                                <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                                  Review diff
                                </span>
                                {reviewDiff.loaded && (
                                  <span className="rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                                    {reviewDiff.files.length} files · {reviewDiff.untracked.length} untracked
                                  </span>
                                )}
                                <span className="rounded-full border border-[rgba(148,163,184,0.5)] px-2 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                                  {formatDiffSource(reviewDiff.source)}
                                </span>
                                {reviewDiff.loaded && reviewDiff.generatedAt && (
                                  <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                                    {formatUTCTime(reviewDiff.generatedAt)}
                                  </span>
                                )}
                              </div>

                              <div className="mb-3 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleLoadReviewDiff(session.id)}
                                  disabled={reviewDiff.loading}
                                  className="rounded-md border border-[var(--color-accent)] px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {reviewDiff.loaded ? (reviewDiff.loading ? "Refreshing..." : "Refresh diff") : "Load diff"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => updateReviewDiffState(session.id, { wrapLines: !reviewDiff.wrapLines })}
                                  className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)]"
                                >
                                  {reviewDiff.wrapLines ? "Wrap: On" : "Wrap: Off"}
                                </button>
                                <input
                                  type="text"
                                  value={reviewDiff.fileSearch}
                                  onChange={(event) => {
                                    const next = event.target.value;
                                    updateReviewDiffState(session.id, {
                                      fileSearch: next,
                                      selectedFilePath: next.trim().length === 0
                                        ? reviewDiff.selectedFilePath
                                        : (reviewDiff.files.find((file) =>
                                          file.path.toLowerCase().includes(next.trim().toLowerCase()),
                                        )?.path ?? reviewDiff.selectedFilePath),
                                    });
                                  }}
                                  placeholder="Filter files..."
                                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 text-[10px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                                />
                                <input
                                  type="text"
                                  value={reviewDiff.search}
                                  onChange={(event) => {
                                    updateReviewDiffState(session.id, {
                                      search: event.target.value,
                                    });
                                  }}
                                  placeholder="Filter diff lines..."
                                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 text-[10px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                                />
                              </div>

                              {reviewDiff.loading && (
                                <div className="rounded-md bg-[var(--color-bg-subtle)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
                                  Loading {formatDiffSource(reviewDiff.source)} diff for this session...
                                </div>
                              )}

                              {reviewDiff.error && (
                                <div className="rounded-md border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.12)] px-2.5 py-2 text-[10px] text-[var(--color-status-error)]">
                                  {reviewDiff.error}
                                </div>
                              )}

                              {reviewDiff.loaded && !reviewDiff.hasDiff && (
                                <div className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
                                  No {formatDiffSource(reviewDiff.source)} diff detected for this session.
                                </div>
                              )}

                              {reviewDiff.loaded && reviewDiff.hasDiff && (
                                <div className="grid gap-2 xl:grid-cols-[22rem_minmax(0,1fr)]">
                                  <div className="space-y-2">
                                    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-2 text-[9px] text-[var(--color-text-muted)]">
                                      File set {filteredFiles.length} / {reviewDiff.files.length}
                                    </div>
                                    <div className="max-h-[320px] overflow-y-auto rounded-md border border-[var(--color-border-subtle)]">
                                      {filteredFiles.length === 0 ? (
                                        <div className="px-2 py-2 text-[10px] text-[var(--color-text-muted)]">
                                          No files match this query.
                                        </div>
                                      ) : (
                                        filteredFiles.map((file) => {
                                          const isSelected = selectedFile?.path === file.path;
                                          const statusColor = file.status === "added"
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
                                              key={`review-file-${session.id}-${file.path}`}
                                              onClick={() => {
                                                updateReviewDiffState(session.id, {
                                                  selectedFilePath: file.path,
                                                });
                                              }}
                                              className={`w-full border-b border-[var(--color-border-subtle)] px-2 py-2 text-left transition-colors last:border-b-0 ${
                                                isSelected
                                                  ? "border-l-2 border-l-[var(--color-accent)] bg-[rgba(59,130,246,0.08)]"
                                                  : "bg-[var(--color-bg-base)] hover:bg-[var(--color-bg-subtle)]"
                                              }`}
                                            >
                                              <div className="flex items-center justify-between gap-2">
                                                <span className="truncate text-[10px] text-[var(--color-text-secondary)]">{file.path}</span>
                                                <span
                                                  className="rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                                                  style={{ background: statusColor }}
                                                >
                                                  {file.status}
                                                </span>
                                              </div>
                                              <div className="mt-1 flex items-center gap-2 text-[9px] text-[var(--color-text-muted)]">
                                                <span>+{file.additions}</span>
                                                <span>−{file.deletions}</span>
                                              </div>
                                            </button>
                                          );
                                        })
                                      )}
                                    </div>
                                  </div>

                                  <div className="space-y-2">
                                    {selectedFile ? (
                                      <div className="overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
                                        <div className="grid grid-cols-[5rem_5rem_1rem_auto] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-2 py-1 text-[9px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                                          <div>old</div>
                                          <div>new</div>
                                          <div></div>
                                          <div>line</div>
                                        </div>
                                        <div
                                          className={`max-h-[320px] overflow-auto font-mono text-[11px] ${reviewDiff.wrapLines ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-nowrap"}`}
                                        >
                                          {visibleLines.length === 0 ? (
                                            <div className="px-2 py-2 text-[10px] text-[var(--color-text-muted)]">
                                              No lines match “{reviewDiff.search}”.
                                            </div>
                                          ) : (
                                            visibleLines.map((line, index) => {
                                              const marker = line.kind === "add"
                                                ? "+"
                                                : line.kind === "remove"
                                                  ? "-"
                                                  : line.kind === "hunk"
                                                    ? "@"
                                                    : line.kind === "meta"
                                                      ? " "
                                                      : line.kind === "info"
                                                        ? "i"
                                                        : " ";
                                              const lineBackground = line.kind === "add"
                                                ? "bg-[rgba(34,197,94,0.12)]"
                                                : line.kind === "remove"
                                                  ? "bg-[rgba(239,68,68,0.12)]"
                                                  : line.kind === "hunk"
                                                    ? "bg-[rgba(59,130,246,0.09)]"
                                                    : "bg-transparent";
                                              const lineTextColor = line.kind === "add"
                                                ? "text-[rgba(52,211,153,1)]"
                                                : line.kind === "remove"
                                                  ? "text-[rgba(248,113,113,1)]"
                                                  : line.kind === "hunk"
                                                    ? "text-[rgba(96,165,250,1)]"
                                                    : line.kind === "meta"
                                                      ? "text-[var(--color-text-muted)]"
                                                      : line.kind === "info"
                                                        ? "text-[var(--color-text-muted)] italic"
                                                        : "text-[var(--color-text-primary)]";

                                              return (
                                                <div
                                                  key={`${selectedFile.path}-${line.oldLine}-${line.newLine}-${index}`}
                                                  className={`grid border-b border-[var(--color-border-subtle)] grid-cols-[5rem_5rem_1rem_auto] px-2 py-0.5 last:border-b-0 ${lineBackground}`}
                                                >
                                                  <div className="text-[10px] text-[var(--color-text-muted)]">
                                                    {line.oldLine ?? ""}
                                                  </div>
                                                  <div className="text-[10px] text-[var(--color-text-muted)]">
                                                    {line.newLine ?? ""}
                                                  </div>
                                                  <div className={lineTextColor}>{marker}</div>
                                                  <div className={lineTextColor}>{line.text}</div>
                                                </div>
                                              );
                                            })
                                          )}
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
                                        Select a file to inspect its diff.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {reviewDiff.loaded && reviewDiff.untracked.length > 0 && (
                                <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                                  <span className="font-semibold text-[var(--color-text-secondary)]">Untracked:</span>{" "}
                                  {reviewDiff.untracked.join(", ")}
                                </div>
                              )}
                              {reviewDiff.loaded && reviewDiff.truncated && (
                                <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                                  Diff output truncated due to size.
                                </div>
                              )}
                            </div>
                          )}
                          <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[linear-gradient(to_right,_rgba(15,23,42,0.32),_rgba(15,23,42,0.15))] p-3 shadow-[0_10px_24px_rgba(2,6,23,0.2)]">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                                  {dashboardTab === "review" ? "Reviewer board" : "Chat board"}
                                </span>
                              </div>
                              <span className="rounded-full border border-[rgba(148,163,184,0.4)] px-2 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
                                {dashboardTab}
                              </span>
                            </div>

                            <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                              {quickActions.map((action) => (
                                <button
                                  key={`${dashboardTab}-${session.id}-${action.label}`}
                                  type="button"
                                  onClick={() => {
                                    applyQuickMessage(session.id, dashboardTab, action.message);
                                  }}
                                  className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated)]"
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>

                            <form
                              className="space-y-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                if (dashboardTab === "review") {
                                  void handleReviewSend(session.id);
                                } else {
                                  void handleChatSend(session.id);
                                }
                              }}
                            >
                              <textarea
                                value={currentMessage}
                                onChange={(event) => {
                                  const next = event.target.value;
                                  if (dashboardTab === "review") {
                                    setReviewMessages((prev) => ({ ...prev, [session.id]: next }));
                                  } else {
                                    setChatMessages((prev) => ({ ...prev, [session.id]: next }));
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    if (dashboardTab === "review") {
                                      void handleReviewSend(session.id);
                                    } else {
                                      void handleChatSend(session.id);
                                    }
                                  }
                                }}
                                rows={3}
                                placeholder={dashboardTab === "review" ? "Reviewer notes..." : "Reply to this agent..."}
                                className="min-h-[84px] w-full resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none transition-[background,color,opacity] focus:border-[var(--color-accent)] focus:bg-[var(--color-bg-surface)]"
                              />
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[9px] text-[var(--color-text-muted)]">
                                  Shift+Enter for line breaks
                                </span>
                                <button
                                  type="submit"
                                  disabled={
                                    dashboardTab === "review"
                                      ? reviewSendingSession === session.id || (reviewMessages[session.id] ?? "").trim().length === 0
                                      : chatSendingSession === session.id || (chatMessages[session.id] ?? "").trim().length === 0
                                  }
                                  className="rounded-md bg-[var(--color-accent)] px-2.5 py-1.5 text-[10px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {dashboardTab === "review"
                                    ? reviewSendingSession === session.id
                                      ? "Sending..."
                                      : "Send review"
                                    : chatSendingSession === session.id
                                      ? "Sending..."
                                      : "Send"}
                                </button>
                              </div>
                            </form>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
          </>
        </main>

        {commandOpen && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(9,11,16,0.58)] p-4 pt-24 backdrop-blur-[1.5px]"
            onClick={() => setCommandOpen(false)}
          >
            <div
              className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] shadow-[0_20px_70px_rgba(0,0,0,0.35)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
                <input
                  ref={commandInputRef}
                  type="text"
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  placeholder="Run command..."
                  className="w-full bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder-[var(--color-text-muted)]"
                />
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-2">
                {visibleCommandActions.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">No commands found.</div>
                ) : (
                  visibleCommandActions.map((action) => (
                    <button
                      key={action.id}
                      onClick={() => {
                        action.run();
                        setCommandOpen(false);
                      }}
                      className="flex w-full items-center rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-elevated)]"
                    >
                      <span className="text-[12px] text-[var(--color-text-primary)]">{action.label}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{action.hint ?? ""}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {cleanupDialog.open && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(9,11,16,0.58)] p-4 backdrop-blur-[1.5px]"
            onClick={() => closeCleanupDialog()}
          >
            <div
              className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] shadow-[0_20px_70px_rgba(0,0,0,0.35)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
                <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                  {cleanupDialog.title}
                </h2>
              </div>
              <div className="px-4 py-3 space-y-3">
                <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                  {cleanupDialog.message}
                </p>
                <div className="max-h-28 overflow-y-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[10px] font-mono text-[var(--color-text-muted)]">
                  {cleanupDialog.sessionIds.map((sessionId) => (
                    <div key={sessionId} className="truncate py-0.5">
                      {sessionId}
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeCleanupDialog}
                    disabled={cleanupDialogBusy}
                    className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void confirmCleanup();
                    }}
                    disabled={cleanupDialogBusy}
                    className="rounded-md bg-[var(--color-status-error)] px-2.5 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:opacity-50"
                  >
                    {cleanupDialogBusy ? "Cleaning..." : cleanupDialogLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Stat pill badge for the header */
function getCIBadgeStyle(status: CICheckState) {
  return CI_STATUS_META[status] ?? CI_STATUS_META.none;
}

function getCheckBadgeStatus(status: CICheckInfo["status"]): CICheckState {
  if (status === "passed") return "passing";
  if (status === "failed") return "failing";
  if (status === "running" || status === "pending") return "pending";
  return "none";
}

function formatDiffSource(source: ReviewDiffSource): string {
  return source === "working-tree"
    ? "Working tree"
    : source === "remote-pr"
      ? "Remote PR"
      : "No diff";
}

function formatUTCDateTime(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return "—";

  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function formatUTCTime(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return "—";

  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function formatGeneratedAt(generatedAt: string): string {
  return formatUTCDateTime(generatedAt);
}

function ProjectFavicon({ projectId, repo, iconUrl }: { projectId: string; repo: string | null; iconUrl?: string | null }) {
  const [iconErrorIndex, setIconErrorIndex] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const faviconUrls = useMemo(() => getProjectFaviconUrls(repo, iconUrl), [repo, iconUrl]);
  useEffect(() => {
    setIconErrorIndex(0);
    setIsLoaded(false);
  }, [repo, iconUrl]);
  useEffect(() => setIsLoaded(false), [iconErrorIndex]);
  const FALLBACK_COLORS = useMemo(
    () => [
      "#14b8a6",
      "#22c55e",
      "#84cc16",
      "#eab308",
      "#f97316",
      "#f43f5e",
      "#a855f7",
      "#ec4899",
      "#06b6d4",
      "#0ea5e9",
    ],
    [],
  );

  const accent = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < projectId.length; i += 1) {
      hash = (hash * 31 + projectId.charCodeAt(i)) % 360;
    }
    return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? "#6b7280";
  }, [projectId]);

  const onImageError = () => {
    setIsLoaded(false);
    setIconErrorIndex((current) => current + 1);
  };

  const shouldUseFallback =
    !faviconUrls.length || iconErrorIndex >= faviconUrls.length || !faviconUrls[iconErrorIndex];

  if (shouldUseFallback) {
    return <DefaultProjectIcon projectId={projectId} color={accent} />;
  }

  return (
    <span className="relative inline-flex h-5 w-5 shrink-0">
      {!isLoaded && <DefaultProjectIcon projectId={projectId} color={accent} />}
      <img
        src={faviconUrls[iconErrorIndex]}
        alt={`${projectId} favicon`}
        className={`h-5 w-5 shrink-0 rounded-sm border border-[var(--color-border-subtle)] bg-white object-cover ${isLoaded ? "inline-flex" : "hidden"}`}
        onError={onImageError}
        onLoad={() => setIsLoaded(true)}
        loading="lazy"
      />
    </span>
  );
}

function GitHubLogo({ className = "h-4 w-4", fillColor }: LogoIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={fillColor ? { color: fillColor } : undefined}
    >
      <title>GitHub</title>
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill={fillColor || "currentColor"}
      />
    </svg>
  );
}

function ObsidianLogo({ className = "h-4 w-4", fillColor }: LogoIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={fillColor ? { color: fillColor } : undefined}
    >
      <title>Obsidian</title>
      <path
        d="M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z"
        fill={fillColor || "currentColor"}
      />
    </svg>
  );
}

function StatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1"
      style={{
        borderColor: color ? `color-mix(in srgb, ${color} 25%, transparent)` : "var(--color-border-default)",
        background: color ? `color-mix(in srgb, ${color} 8%, transparent)` : "transparent",
      }}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
        />
      )}
      <span
        className="text-[12px] font-semibold tabular-nums"
        style={{ color: color ?? "var(--color-text-primary)" }}
      >
        {value}
      </span>
      <span className="text-[10px] text-[var(--color-text-muted)]">
        {label}
      </span>
    </div>
  );
}

const ATTENTION_RANK: Record<AttentionGroup, number> = {
  respond: 0,
  review: 1,
  merge: 2,
  pending: 3,
  working: 4,
  done: 5,
};

const LANE_META: Array<{ id: AttentionGroup; title: string; color: string }> = [
  { id: "respond", title: "Respond", color: "var(--color-status-error)" },
  { id: "review", title: "Review", color: "var(--color-accent-orange)" },
  { id: "merge", title: "Merge", color: "var(--color-status-ready)" },
  { id: "pending", title: "Pending", color: "var(--color-status-attention)" },
  { id: "working", title: "Working", color: "var(--color-status-working)" },
  { id: "done", title: "Done", color: "var(--color-text-muted)" },
];

function attentionRank(session: DashboardSession): number {
  const level = getAttentionLevel(session) as AttentionGroup;
  return ATTENTION_RANK[level] ?? 99;
}

function parseEstimatedCost(session: DashboardSession): number {
  const raw = session.metadata["cost"];
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { estimatedCostUsd?: number; totalUSD?: number };
    return parsed.estimatedCostUsd ?? parsed.totalUSD ?? 0;
  } catch {
    return 0;
  }
}

function LaneColumn({
  title,
  color,
  count,
  children,
}: {
  title: string;
  color: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="w-[360px] shrink-0 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <h2 className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
        <span className="ml-auto rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">{count}</span>
      </div>
      {children}
    </section>
  );
}
