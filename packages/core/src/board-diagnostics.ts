import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoardConfigEntry, ColumnAliasesConfig, OrchestratorConfig } from "./types.js";
import {
  DEFAULT_COLUMN_ALIASES,
  parseBoardSections,
  resolveColumnAliases,
  resolveColumnsFromBoard,
} from "./board-parser.js";

export interface WatcherAction {
  ts: string;
  level: "info" | "error" | "debug";
  action: string;
  boardPath?: string;
  context?: string;
}

export interface BoardParseStatus {
  boardPath: string;
  exists: boolean;
  parseOk: boolean;
  headingCount: number;
  headings: string[];
  columns: Record<string, string>;
  readyCount: number;
  unresolvedProjects: string[];
  errors: string[];
}

export interface DoctorReport {
  watchedBoards: string[];
  aliasMapping: Record<string, Required<ColumnAliasesConfig>>;
  boardStatus: BoardParseStatus[];
  unresolvedProjectTags: Array<{ boardPath: string; tag: string }>;
  recentActions: WatcherAction[];
  hints: string[];
}

const LOG_DIR_REL = join("orchestrator", "logs");
const ACTION_LOG = "watcher-actions.log";
const DEBUG_LOG = "watcher-debug.log";
const MAX_LOG_BYTES = 1_000_000;
const LOG_ROTATIONS = 3;

function normalizePath(pathname: string): string {
  return canonicalizeExistingPath(pathname).replace(/\\/g, "/");
}

function canonicalizeExistingPath(pathname: string): string {
  if (!existsSync(pathname)) return pathname;
  try {
    return realpathSync.native(pathname);
  } catch {
    return pathname;
  }
}

function ensureParent(pathname: string): void {
  mkdirSync(dirname(pathname), { recursive: true });
}

function rotateLogIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return;
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;

  for (let i = LOG_ROTATIONS; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (!existsSync(src)) continue;
    if (i === LOG_ROTATIONS) {
      try {
        renameSync(src, dst);
      } catch {
        // best effort
      }
      continue;
    }
    try {
      renameSync(src, dst);
    } catch {
      // best effort
    }
  }

  try {
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // best effort
  }
}

function toAbsolutePattern(workspacePath: string, pattern: string): string {
  const normalized = normalizePath(pattern.trim());
  if (!normalized) return normalized;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return normalized;
  return normalizePath(join(workspacePath, normalized));
}

function globToRegex(pattern: string): RegExp {
  const escaped = normalizePath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function matchesBoardPattern(boardPath: string, workspacePath: string, pattern: string): boolean {
  const absolutePattern = toAbsolutePattern(workspacePath, pattern);
  const normalizedBoard = normalizePath(boardPath);
  if (!absolutePattern.includes("*") && !absolutePattern.includes("?")) {
    return normalizedBoard === absolutePattern;
  }
  return globToRegex(absolutePattern).test(normalizedBoard);
}

export function resolveBoardAliasesForPath(
  config: OrchestratorConfig,
  workspacePath: string,
  boardPath: string,
): Required<ColumnAliasesConfig> {
  let aliases = resolveColumnAliases(config.columnAliases);

  for (const entry of config.boards ?? []) {
    if (typeof entry === "string") continue;
    if (!entry.aliases) continue;
    if (!matchesBoardPattern(boardPath, workspacePath, entry.path)) continue;
    aliases = resolveColumnAliases(aliases, entry.aliases);
  }

  return aliases;
}

function extractUnresolvedProjectTags(content: string, projectIds: Set<string>): string[] {
  const unresolved = new Set<string>();
  for (const match of content.matchAll(/#project\/([\w.-]+)/g)) {
    const tag = match[1] ?? "";
    if (!tag) continue;
    if (!projectIds.has(tag)) unresolved.add(tag);
  }
  return [...unresolved];
}

export function parseBoardStatus(
  boardPath: string,
  content: string,
  aliases: Required<ColumnAliasesConfig>,
  projectIds: Set<string>,
): BoardParseStatus {
  const sections = parseBoardSections(content);
  const resolved = resolveColumnsFromBoard(content, aliases);
  const readyHeading = resolved.columnsByRole.ready;

  let readyCount = 0;
  for (const section of sections) {
    if (section.heading !== readyHeading) continue;
    for (const line of section.lines) {
      if (/^\s*(?:>\s*)?-\s\[\s\]\s+/.test(line)) readyCount++;
    }
  }

  const requiredRoles: Array<keyof typeof resolved.columnsByRole> = ["intake", "ready", "review", "done"];
  const headingSet = new Set(sections.map((section) => section.heading.toLowerCase()));
  const errors: string[] = [];
  for (const role of requiredRoles) {
    const heading = resolved.columnsByRole[role];
    if (!headingSet.has(heading.toLowerCase())) {
      errors.push(`Missing expected ${role} column (${heading})`);
    }
  }

  return {
    boardPath,
    exists: true,
    parseOk: errors.length === 0,
    headingCount: sections.length,
    headings: sections.map((section) => section.heading),
    columns: resolved.columnsByRole,
    readyCount,
    unresolvedProjects: extractUnresolvedProjectTags(content, projectIds),
    errors,
  };
}

function watcherLogPath(workspacePath: string, filename: string): string {
  return join(workspacePath, LOG_DIR_REL, filename);
}

export function recordWatcherAction(
  workspacePath: string,
  action: Omit<WatcherAction, "ts">,
): void {
  const payload: WatcherAction = { ...action, ts: new Date().toISOString() };
  const actionsPath = watcherLogPath(workspacePath, ACTION_LOG);
  ensureParent(actionsPath);
  rotateLogIfNeeded(actionsPath);

  try {
    appendFileSync(actionsPath, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch {
    // best effort
  }

  if (process.env["CONDUCTOR_DEBUG"] !== "1") return;

  const debugPath = watcherLogPath(workspacePath, DEBUG_LOG);
  ensureParent(debugPath);
  rotateLogIfNeeded(debugPath);
  const line = `[${payload.ts}] [${payload.level}] ${payload.action}${payload.boardPath ? ` [${payload.boardPath}]` : ""}${payload.context ? ` ${payload.context}` : ""}\n`;
  try {
    appendFileSync(debugPath, line, "utf-8");
  } catch {
    // best effort
  }
}

export function readRecentWatcherActions(workspacePath: string, limit = 20): WatcherAction[] {
  const actionsPath = watcherLogPath(workspacePath, ACTION_LOG);
  if (!existsSync(actionsPath)) return [];

  try {
    const lines = readFileSync(actionsPath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as WatcherAction;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is WatcherAction => entry !== null);
  } catch {
    return [];
  }
}

export function boardEntriesToPaths(entries: BoardConfigEntry[] | undefined): string[] {
  if (!entries) return [];
  const out: string[] = [];
  for (const entry of entries) {
    out.push(typeof entry === "string" ? entry : entry.path);
  }
  return out;
}

export function defaultAliasMapping(): Required<ColumnAliasesConfig> {
  return { ...DEFAULT_COLUMN_ALIASES };
}
