/**
 * Board Watcher -- watches Obsidian CONDUCTOR.md kanban boards for changes.
 *
 * When a task is moved to "Ready to Dispatch", the watcher:
 *   1. Parses the card text for tags (#agent/codex, #project/my-app, #issue/42)
 *   2. Calls SessionManager.spawn() to create an agent session
 *   3. Moves the card to "Dispatching" with the session ID
 *   4. On session completion, moves to "Done" with PR link
 *
 * Card format:
 *   - [ ] fix the login bug #agent/codex #model/o4-mini #project/my-app #type/bug
 *   - [ ] add dark mode #agent/claude-code #model/claude-opus-4-6
 *   - [ ] implement #42
 *
 * Board columns: Inbox → Ready to Dispatch → Dispatching → In Progress → Review → Done → Blocked
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync, mkdirSync, watch as fsWatch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  BoardConfigEntry,
  OrchestratorConfig,
  SessionManager,
  Session,
  PRInfo,
  TaskAttachment,
} from "./types.js";
import {
  getSectionsByAliases,
  getTrackedCardLines,
  getUncheckedTasks,
  moveCardLine,
  moveUncheckedTask,
  replaceLine,
  resolveColumnsFromBoard,
  parseChecklistPrefix,
  type ResolvedBoardColumns,
} from "./board-parser.js";
import { recordWatcherAction, resolveBoardAliasesForPath } from "./board-diagnostics.js";
import { isSupportedAgent, normalizeAgentName } from "./agent-names.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoardWatcherConfig {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  boardPaths: string[];
  /** Project ID to board path mapping (derived from board location). */
  boardProjectMap: Map<string, string>;
  /** Optional list of supported agent names. If omitted, inferred agents are discovered from manifests. */
  agentNames?: string[];
  /** Polling interval in ms for fswatch fallback. Default: 3000. */
  pollIntervalMs?: number;
  /** Base URL of the dashboard for session links in cards. */
  dashboardUrl?: string;
  /** Obsidian vault / workspace path for session notes. */
  workspacePath?: string;
  onDispatch?: (projectId: string, sessionId: string, task: string) => void;
  onError?: (error: Error, context: string) => void;
}

const FALLBACK_WATCHER_AGENTS = [
  "codex",
  "claude-code",
  "gemini",
  "amp",
  "cursor-cli",
  "opencode",
  "droid",
  "qwen-code",
  "ccr",
  "github-copilot",
] as const;

function splitKeywords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
}

function hasKeyword(text: string, keyword: string): boolean {
  if (!keyword.trim()) return false;

  const normalized = text.toLowerCase();
  const tokens = splitKeywords(normalized);
  const normalizedKeyword = keyword.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalizedKeyword.includes(" ")) {
    const parts = normalizedKeyword.split(" ");
    const window = parts.length;
    if (window === 0) return false;
    for (let i = 0; i + window <= tokens.length; i += 1) {
      if (tokens.slice(i, i + window).join(" ") === normalizedKeyword) return true;
    }
    return false;
  }

  return tokens.includes(normalizedKeyword);
}

function resolveSupportedAgent(agent: string, supportedAgents: readonly string[]): string {
  if (!agent) return supportedAgents[0] ?? normalizeAgentName("codex", FALLBACK_WATCHER_AGENTS);
  const normalized = normalizeAgentName(agent, supportedAgents);
  if (!isSupportedAgent(normalized, supportedAgents)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  return normalized;
}

function uniqueAgents(values: readonly string[]): string[] {
  const set = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (set.has(lower)) continue;
    set.add(lower);
    out.push(lower);
  }
  return out;
}

interface ParsedCard {
  raw: string;
  prompt: string;
  agent: string | undefined;
  model: string | undefined;
  profile: string | undefined;
  project: string | undefined;
  issueId: string | undefined;
  taskType: string | undefined;
  priority: string | undefined;
  taskId: string | undefined;
  attemptId: string | undefined;
  parentTaskId: string | undefined;
  /** Image/file attachments referenced in the card. */
  attachments: TaskAttachment[];
}

// ---------------------------------------------------------------------------
// Card Parsing
// ---------------------------------------------------------------------------

/** Parse tags from card text: #agent/codex, #model/o4-mini, #project/my-app, #issue/42, #type/bug, #priority/high */
function parseTags(text: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const match of text.matchAll(/#([\w-]+)\/([\w.\-]+)/g)) {
    tags[match[1]] = match[2];
  }
  return tags;
}

/** Strip tags and image embeds from card text to get the clean prompt. */
function stripTags(text: string): string {
  return text
    .replace(/#[\w-]+\/[\w.\-]+/g, "")           // #agent/codex etc.
    .replace(/!\[\[([^\]]+)\]\]/g, "")             // ![[image.png]]
    .replace(/\[\[([^\]]+)\]\]/g, "")              // [[note.md]]
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "")      // ![alt](path)
    .replace(/\[(task|attempt|parent):[^\]]+\]/g, "") // [task:t-001] style metadata
    .replace(/\s+/g, " ")
    .trim();
}

function parseInlineMetadata(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const match of text.matchAll(/\[(task|attempt|parent):([^\]]+)\]/g)) {
    const key = match[1];
    const value = (match[2] ?? "").trim();
    if (key && value) {
      meta[key] = value;
    }
  }
  return meta;
}

// =============================================================================
// Inbox Task Enhancement (smart auto-tagging)
// =============================================================================

interface InboxEntry {
  /** Raw block text as it appears in the Inbox section (may be multiline). */
  block: string;
  /** Normalized task text without checkbox prefix. */
  text: string;
}

/** Parse intake entries. Supports checkbox cards and plain text lines. */
function getInboxEntries(content: string, intakeAliases: readonly string[]): InboxEntry[] {
  const sections = getSectionsByAliases(content, intakeAliases);
  if (sections.length === 0) return [];

  const entries: InboxEntry[] = [];

  for (const section of sections) {
    const lines = section.lines;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? "";
      if (!rawLine.trim()) continue;

      let line = rawLine;
      if (rawLine.trimStart().startsWith(">")) {
        const unquoted = rawLine.trimStart().replace(/^>\s?/, "");
        const lower = unquoted.trim().toLowerCase();
        const isInstruction =
          lower.startsWith("drop rough ideas")
          || lower.startsWith("move tagged tasks")
          || lower.startsWith("agent finished")
          || lower.startsWith("tags:");
        if (isInstruction || !unquoted.trim()) continue;
        line = unquoted;
      }

      const isChecklistStart = (value: string): boolean => parseChecklistPrefix(value) !== null;
      const checkboxText = parseChecklistMatch(line);
      if (checkboxText) {
        const blockLines = [rawLine];
        let text = checkboxText;
        while (
          i + 1 < lines.length
          && /^[\t ]/.test(lines[i + 1] ?? "")
          && !isChecklistStart((lines[i + 1] ?? "").trimStart())
        ) {
          i++;
          const contRaw = lines[i] ?? "";
          const cont = contRaw.trimStart().replace(/^>\s?/, "").trim();
          blockLines.push(contRaw);
          if (cont) text += ` ${cont}`;
        }
        entries.push({ block: blockLines.join("\n"), text: text.replace(/\s+/g, " ").trim() });
        continue;
      }

      if (!line.trimStart().startsWith("## ") && !line.trimStart().startsWith("%%") && !line.trimStart().startsWith("```")) {
        const blockLines = [rawLine];
        let text = line.trim();
        while (
          i + 1 < lines.length
          && /^[\t ]/.test(lines[i + 1] ?? "")
          && !isChecklistStart((lines[i + 1] ?? "").trimStart())
        ) {
          i++;
          const contRaw = lines[i] ?? "";
          const cont = contRaw.trimStart().replace(/^>\s?/, "").trim();
          blockLines.push(contRaw);
          if (cont) text += ` ${cont}`;
        }
        if (text) entries.push({ block: blockLines.join("\n"), text: text.replace(/\s+/g, " ").trim() });
      }
    }
  }

  return entries;
}

function parseChecklistMatch(line: string): string | null {
  const match = parseChecklistPrefix(line);
  if (!match) return null;
  const text = line.slice(match.textStart);
  if (!text) return null;
  return text;
}

/** Check if a task already has required orchestration tags. */
function hasProperTags(taskText: string): boolean {
  return /#agent\//.test(taskText) && /#project\//.test(taskText);
}

/** Infer project from text keywords + board context. */
function inferProject(text: string, boardProjectId: string | undefined, boardProjects: string[]): string {
  const tagged = parseTags(text)["project"];
  if (tagged) return tagged;
  if (boardProjectId) return boardProjectId;
  if (boardProjects.length === 1) return boardProjects[0] ?? "my-app";

  // When multiple projects share a board, match keywords in the task text
  // against project IDs. Split each projectId on hyphens and check for matches.
  const lower = text.toLowerCase();
  let bestMatch: string | undefined;
  let bestScore = 0;
  for (const projectId of boardProjects) {
    const parts = projectId.toLowerCase().split("-");
    let score = 0;
    for (const part of parts) {
      if (part.length >= 3 && lower.includes(part)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = projectId;
    }
  }
  if (bestMatch && bestScore > 0) return bestMatch;
  return boardProjects[0] ?? "my-app";
}

function inferAgent(text: string, supportedAgents: readonly string[]): string {
  const tagged = parseTags(text)["agent"];
  if (tagged) return resolveSupportedAgent(tagged, supportedAgents);
  const lower = text.toLowerCase();
  const claudeKeywords = ["architecture", "refactor", "design", "figma", "complex", "plan", "review"];
  if (claudeKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("claude-code", supportedAgents);
  const geminiKeywords = ["gemini", "google", "vertex"];
  if (geminiKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("gemini", supportedAgents);
  const ampKeywords = ["amplify", "amp"];
  if (ampKeywords.some((k) => hasKeyword(lower, k))) return resolveSupportedAgent("amp", supportedAgents);
  const cursorKeywords = ["cursor"];
  if (cursorKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("cursor-cli", supportedAgents);
  const droidKeywords = ["robot", "agentic", "android", "droid"];
  if (droidKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("droid", supportedAgents);
  const qwenKeywords = ["qwen", "alibaba", "qwen-code", "qwen code"];
  if (qwenKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("qwen-code", supportedAgents);
  const copilotKeywords = ["copilot", "github copilot", "gh copilot"];
  if (copilotKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("github-copilot", supportedAgents);
  const ccrKeywords = ["ccr", "claude code router", "claude-code-router"];
  if (ccrKeywords.some((k) => lower.includes(k))) return resolveSupportedAgent("ccr", supportedAgents);
  return supportedAgents[0] ?? normalizeAgentName("codex", FALLBACK_WATCHER_AGENTS);
}

function inferType(text: string): string {
  const tagged = parseTags(text)["type"];
  if (tagged) return tagged;
  const lower = text.toLowerCase();
  if (lower.includes("review")) return "review";
  if (lower.includes("bug") || lower.includes("broken") || lower.includes("fix")) return "bug";
  if (lower.includes("test") || lower.includes("qa")) return "test";
  if (lower.includes("refactor")) return "refactor";
  return "feature";
}

function inferPriority(text: string): string {
  const tagged = parseTags(text)["priority"];
  if (tagged) return tagged;
  const lower = text.toLowerCase();
  if (/(urgent|critical|asap|broken|login|auth)/.test(lower)) return "high";
  if (/(minor|nice to have|later)/.test(lower)) return "low";
  return "medium";
}

/** Heuristic task enhancement: formats with checkbox + tags. Never splits tasks. */
function enhanceTaskHeuristically(
  rawTask: string,
  boardProjectId: string | undefined,
  boardProjects: string[],
  supportedAgents: readonly string[],
): string | null {
  const normalized = stripTags(rawTask).replace(/^\s*[\-*•]\s*/, "").replace(/^\s*\[\s?\]\s*/, "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  if (hasProperTags(rawTask)) {
    // Already tagged — only reformat if not a proper checklist item
    const agentFromTag = parseTags(rawTask)["agent"];
    if (agentFromTag) {
      const normalizedAgent = resolveSupportedAgent(agentFromTag, supportedAgents);
      const canonicalAgent = normalizeAgentName(normalizedAgent, supportedAgents);
      if (normalizeAgentName(agentFromTag, supportedAgents) !== canonicalAgent) {
        rawTask = rawTask.replace(`#agent/${agentFromTag}`, `#agent/${canonicalAgent}`);
      }
      const tags = rawTask.match(/#[\w-]+\/[\w.\-]+/g) ?? [];
      const normalizedTags = tags.map((tag) =>
        tag.startsWith("#agent/")
          ? `#agent/${canonicalAgent}`
          : tag
      );
      if (rawTask.startsWith("- [ ] ")) return null;
      return `- [ ] ${normalized} ${normalizedTags.join(" ")}`.trim();
    }
    if (rawTask.startsWith("- [ ] ")) return null; // no change needed
    return `- [ ] ${normalized} ${rawTask.match(/#[\w-]+\/[\w.\-]+/g)?.join(" ") ?? ""}`.trim();
  }

  const project = inferProject(rawTask, boardProjectId, boardProjects);
  const agent = inferAgent(rawTask, supportedAgents);
  const type = inferType(rawTask);
  const priority = inferPriority(rawTask);

  return `- [ ] ${normalized} #agent/${agent} #project/${project} #type/${type} #priority/${priority}`;
}

/** Enhance rough Inbox tasks in-place. Never moves columns — user reviews then moves to Ready to Dispatch. */
/**
 * Content-aware write guard (module scope — shared by boardWatcher).
 * After writing a board file, stores content + timestamp. Any external write
 * (Obsidian Kanban plugin) within the guard window gets overwritten with ours.
 */
const writeGuard = new Map<string, { content: string; at: number }>();
const WRITE_GUARD_MS = 15_000;
/** Nudge Obsidian to reload a file after external write. */
function nudgeObsidian(boardPath: string): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  try {
    let vaultRoot = dirname(boardPath);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(vaultRoot, ".obsidian"))) break;
      vaultRoot = dirname(vaultRoot);
    }
    const vaultName = basename(vaultRoot);
    const relPath = boardPath
      .substring(boardPath.indexOf(vaultName + "/") + vaultName.length + 1)
      .replace(/\.md$/, "");
    const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relPath)}`;
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${cmd} "${uri}"`, { timeout: 3_000, stdio: "ignore" });
  } catch {
    // Non-fatal — Obsidian may not be running
  }
}


async function enhanceInbox(
  boardPath: string,
  config: OrchestratorConfig,
  supportedAgents: readonly string[],
): Promise<void> {
  if (!existsSync(boardPath)) return;
  const content = readFileSync(boardPath, "utf-8");

  // During guard window, ignore only our own just-written content.
  // If user edited the file (content differs), process immediately.
  const guard = writeGuard.get(boardPath);
  if (guard && Date.now() - guard.at < WRITE_GUARD_MS && content === guard.content) {
    return;
  }
  const workspacePath = process.env["CONDUCTOR_WORKSPACE"] ?? process.cwd();
  const aliases = resolveBoardAliasesForPath(config, workspacePath, boardPath);
  const entries = getInboxEntries(content, aliases.intake);
  if (entries.length === 0) return;

  const boardProjectId = projectFromBoardPath(boardPath, config);
  const dirName = basename(dirname(boardPath));
  let boardProjects = Object.entries(config.projects)
    .filter(([key, proj]) => key === dirName || (proj as { boardDir?: string }).boardDir === dirName)
    .map(([key]) => key);

  // Root workspace board isn't tied to a single project directory.
  // Fall back to all configured projects so keyword inference can pick
  // a real project tag instead of defaulting to #project/my-app.
  if (boardProjects.length === 0) {
    boardProjects = Object.keys(config.projects);
  }

  let updatedContent = content;
  let anyChanged = false;

  for (const entry of entries) {
    if (hasProperTags(entry.text)) continue;
    const enhanced = enhanceTaskHeuristically(
      entry.text,
      boardProjectId,
      boardProjects,
      supportedAgents,
    );
    if (!enhanced) continue;
    if (updatedContent.includes(entry.block)) {
      updatedContent = updatedContent.replace(entry.block, enhanced);
      anyChanged = true;
      console.log(`[board-watcher] Inbox enhanced: "${entry.text.substring(0, 60)}"`);
      recordWatcherAction(workspacePath, {
        level: "info",
        action: `Inbox enhanced: ${entry.text.substring(0, 60)}`,
        boardPath,
      });
    }
  }

  if (anyChanged) {
    writeFileSync(boardPath, updatedContent, "utf-8");
    writeGuard.set(boardPath, { content: updatedContent, at: Date.now() });
    console.log(`[board-watcher] Inbox enhancement written: ${boardPath}`);
    recordWatcherAction(workspacePath, {
      level: "info",
      action: "Inbox enhancement written",
      boardPath,
    });

    nudgeObsidian(boardPath);
  }
}

/** Image file extensions for type detection. */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff",
]);

function attachmentTypeFromPath(value: string): "image" | "file" {
  const normalized = value.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (normalized.endsWith(ext)) return "image";
  }
  return "file";
}

function stripWikiDecorators(rawPath: string): string {
  let value = rawPath.trim();
  const pipeIndex = value.indexOf("|");
  if (pipeIndex >= 0) value = value.slice(0, pipeIndex);
  const hashIndex = value.indexOf("#");
  if (hashIndex >= 0) value = value.slice(0, hashIndex);
  return value.trim();
}

function stripMarkdownLinkDecorators(rawPath: string): string {
  let value = rawPath.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }
  const withTitle = value.match(/^(.+?)\s+["'][^"']*["']$/);
  if (withTitle?.[1]) {
    value = withTitle[1].trim();
  }
  return value;
}

/** Extract image/file attachment references from card text. */
function extractAttachments(text: string, workspacePath: string): TaskAttachment[] {
  const attachments: TaskAttachment[] = [];
  const seen = new Set<string>();

  const addAttachment = (ref: string, rawPath: string): void => {
    const resolved = resolveAttachmentPath(rawPath, workspacePath);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    attachments.push({
      path: resolved,
      ref,
      type: attachmentTypeFromPath(rawPath),
    });
  };

  // Obsidian wiki-link embeds: ![[image.png]] or ![[folder/mockup.png]]
  for (const match of text.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const ref = match[0];
    const rawPath = match[1]!;
    addAttachment(ref, rawPath);
  }

  // Obsidian wiki-links: [[context/spec.md]] or [[note|label]]
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === "!") continue;
    const ref = match[0];
    const rawPath = match[1]!;
    addAttachment(ref, rawPath);
  }

  // Standard markdown embeds: ![alt text](path/to/file.png)
  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const ref = match[0];
    const rawPath = match[2]!;
    addAttachment(ref, rawPath);
  }

  // Standard markdown links to local files: [Spec](docs/spec.md)
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === "!") continue;
    const ref = match[0];
    const rawPath = match[2]!;
    addAttachment(ref, rawPath);
  }

  return attachments;
}

/**
 * Resolve an attachment path relative to the workspace.
 * Only allows paths that resolve within the workspace directory (path traversal protection).
 */
function resolveAttachmentPath(rawPath: string, workspacePath: string): string | null {
  if (!rawPath.trim()) return null;

  let normalizedRawPath = stripWikiDecorators(rawPath);
  normalizedRawPath = stripMarkdownLinkDecorators(normalizedRawPath);
  normalizedRawPath = normalizedRawPath.trim();
  if (!normalizedRawPath) return null;

  // Ignore web links, vault deep links, and anchors.
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedRawPath)
    || normalizedRawPath.startsWith("obsidian://")
    || normalizedRawPath.startsWith("mailto:")
    || normalizedRawPath.startsWith("#")
  ) {
    return null;
  }

  try {
    normalizedRawPath = decodeURIComponent(normalizedRawPath);
  } catch {
    // Keep original when path contains malformed %-encoding.
  }
  normalizedRawPath = normalizedRawPath.replace(/\\/g, "/").trim();

  // Block absolute paths and ~ expansion — only allow workspace-relative paths.
  // This prevents path traversal attacks via cards referencing /etc/passwd, ~/.ssh/id_rsa, etc.
  if (normalizedRawPath.startsWith("/") || normalizedRawPath.startsWith("~")) {
    return null;
  }

  const workspaceRoot = resolve(workspacePath);
  const workspacePrefix = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
  const resolved = resolve(workspaceRoot, normalizedRawPath);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspacePrefix)) {
    return null;
  }

  if (existsSync(resolved)) return resolved;

  // Obsidian note links commonly omit the .md extension.
  if (!normalizedRawPath.endsWith(".md")) {
    const withMd = resolve(workspaceRoot, `${normalizedRawPath}.md`);
    if ((withMd === workspaceRoot || withMd.startsWith(workspacePrefix)) && existsSync(withMd)) {
      return withMd;
    }
  }

  // Try attachments subfolder (common Obsidian convention)
  const inAttachments = resolve(workspaceRoot, "attachments", normalizedRawPath);
  if ((inAttachments === workspaceRoot || inAttachments.startsWith(workspacePrefix)) && existsSync(inAttachments)) {
    return inAttachments;
  }

  // File doesn't exist yet — still pass the path so the agent gets the reference
  return resolved;
}

/** Detect issue references like #42 or INT-123. */
function detectIssue(text: string): string | undefined {
  // Explicit #issue/ tag takes priority (already parsed)
  // Look for bare #N patterns (but not #agent/... or #project/...)
  const bareIssue = text.match(/(?<!\w)#(\d+)(?!\w)/);
  if (bareIssue) return bareIssue[1];
  // Jira-style: INT-123, PROJ-456
  const jiraMatch = text.match(/\b([A-Z]{2,10}-\d+)\b/);
  if (jiraMatch) return jiraMatch[1];
  return undefined;
}

/** Normalize agent shorthand aliases to canonical plugin names. */
function normalizeAgent(agent: string, supportedAgents: readonly string[]): string {
  return resolveSupportedAgent(agent, supportedAgents);
}

/** Auto-detect agent from task description if no #agent/ tag. */
function autoDetectAgent(prompt: string, supportedAgents: readonly string[]): string {
  const lower = prompt.toLowerCase();
  const claudeKeywords = ["design", "architect", "plan", "feature", "build new", "refactor", "complex"];
  for (const kw of claudeKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("claude-code", supportedAgents);
  }
  const geminiKeywords = ["gemini", "google", "vertex"];
  for (const kw of geminiKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("gemini", supportedAgents);
  }
  const ampKeywords = ["amplify", "amp"];
  for (const kw of ampKeywords) {
    if (hasKeyword(lower, kw)) return resolveSupportedAgent("amp", supportedAgents);
  }
  const cursorKeywords = ["cursor"];
  for (const kw of cursorKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("cursor-cli", supportedAgents);
  }
  const droidKeywords = ["robot", "agentic", "android", "droid"];
  for (const kw of droidKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("droid", supportedAgents);
  }
  const qwenKeywords = ["qwen", "qwen-code", "qwen code"];
  for (const kw of qwenKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("qwen-code", supportedAgents);
  }
  const copilotKeywords = ["copilot", "github copilot", "gh copilot"];
  for (const kw of copilotKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("github-copilot", supportedAgents);
  }
  const ccrKeywords = ["ccr", "claude code router", "claude-code-router"];
  for (const kw of ccrKeywords) {
    if (lower.includes(kw)) return resolveSupportedAgent("ccr", supportedAgents);
  }
  return supportedAgents[0] ?? normalizeAgentName("codex", FALLBACK_WATCHER_AGENTS);
}
/** Parse a kanban card into structured data. */
function parseCard(cardText: string, workspacePath: string): ParsedCard {
  const tags = parseTags(cardText);
  const metadata = parseInlineMetadata(cardText);
  const prompt = stripTags(cardText);
  const issueFromTag = tags["issue"];
  const issueFromText = detectIssue(cardText);
  const attachments = extractAttachments(cardText, workspacePath);

  return {
    raw: cardText,
    prompt,
    agent: tags["agent"],
    model: tags["model"],
    profile: tags["profile"],
    project: tags["project"],
    issueId: issueFromTag ?? issueFromText,
    taskType: tags["type"],
    priority: tags["priority"],
    taskId: metadata["task"],
    attemptId: metadata["attempt"],
    parentTaskId: metadata["parent"],
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Board Parsing / Editing
// ---------------------------------------------------------------------------

/** Extract tasks from a specific column. Returns unchecked items only. */
function getColumnTasks(content: string, column: string): string[] {
  return getUncheckedTasks(content, column);
}

/** Move a task from one column to another. Updates the card text if needed. */
function moveCard(
  content: string,
  taskText: string,
  fromColumn: string,
  toColumn: string,
  newCardText?: string,
): { content: string; moved: boolean } {
  return moveUncheckedTask(content, taskText, fromColumn, toColumn, newCardText);
}

// ---------------------------------------------------------------------------
// Status Display & Card Tracking
// ---------------------------------------------------------------------------

/** Status emoji for kanban card display. */
const STATUS_EMOJI: Record<string, string> = {
  spawning: "🔄",
  working: "🟢",
  pr_open: "🔵",
  ci_failed: "🔴",
  review_pending: "🟡",
  changes_requested: "🟠",
  approved: "✅",
  mergeable: "🟢",
  merged: "✨",
  cleanup: "🧹",
  needs_input: "⏸️",
  stuck: "⚠️",
  errored: "❌",
  killed: "💀",
  done: "✅",
  terminated: "🛑",
};

/** Terminal statuses that get enriched Done card format. */
const DONE_STATUSES: ReadonlySet<string> = new Set([
  "done", "merged", "killed", "terminated", "cleanup", "errored",
]);

/** Format a duration between two dates into a human-readable string. */
function formatDuration(startDate: Date, endDate: Date): string {
  const ms = endDate.getTime() - startDate.getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

/** Format a cost estimate into a readable string. */
function formatCost(costUsd: number): string {
  if (costUsd <= 0) return "";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

function formatTaskMarkers(meta: Record<string, string | undefined>): string {
  const parts: string[] = [];
  const taskId = meta["taskId"];
  const attemptId = meta["attemptId"];
  const parentTaskId = meta["parentTaskId"];
  if (taskId) parts.push(`[task:${taskId}]`);
  if (attemptId) parts.push(`[attempt:${attemptId}]`);
  if (parentTaskId) parts.push(`[parent:${parentTaskId}]`);
  return parts.join(" ");
}

/** Map session status to canonical board role. */
function statusToColumnRole(status: string): "dispatching" | "inProgress" | "review" | "done" | "blocked" {
  switch (status) {
    case "spawning":
      return "dispatching";
    case "working":
      return "inProgress";
    case "pr_open":
    case "ci_failed":
    case "review_pending":
    case "changes_requested":
    case "approved":
    case "mergeable":
      return "review";
    case "merged":
    case "done":
    case "cleanup":
    case "killed":
    case "terminated":
      return "done";
    case "stuck":
    case "errored":
    case "needs_input":
      return "blocked";
    default:
      return "inProgress";
  }
}

// ---------------------------------------------------------------------------
// Tracked Card Parsing
// ---------------------------------------------------------------------------

interface TrackedCard {
  sessionId: string;
  line: string;
  column: string;
  basePrompt: string;
  taskId: string | null;
  attemptId: string | null;
  parentTaskId: string | null;
}

/** Extract session ID from a card line — matches [prefix-slug-N] not followed by ( (excludes markdown links). */
function extractSessionId(line: string): string | null {
  // Matches both old format [pp-3] and new format [pp-netlify-env-3]
  const matches = [...line.matchAll(/\[([a-zA-Z][\w]*(?:-[\w]+)*-\d+)\](?!\()/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1]!;
}

function extractCardMarker(line: string, marker: "task" | "attempt" | "parent"): string | null {
  const match = line.match(new RegExp(`\\[${marker}:([^\\]]+)\\]`));
  return match?.[1]?.trim() ?? null;
}

/** Extract base prompt from a card line (text before the [sessionId] marker, excluding dynamic suffix). */
function extractBasePrompt(line: string, sessionId: string): string {
  const withoutMeta = line
    .replace(/\s*\[(task|attempt|parent):[^\]]+\]/g, "")
    .replace(/\s+/g, " ");
  const marker = `[${sessionId}]`;
  const afterCheckbox = withoutMeta.replace(/^- \[[ x]\] /, "");
  const markerIdx = afterCheckbox.indexOf(marker);
  if (markerIdx === -1) return afterCheckbox.replace(/\s*—\s*.*$/, "").trim();
  return afterCheckbox.slice(0, markerIdx).trim();
}

/** Get all cards with [sessionId] markers from tracked columns. */
function getAllTrackedCards(content: string, trackedColumns: string[]): TrackedCard[] {
  const cards: TrackedCard[] = [];
  for (const item of getTrackedCardLines(content, trackedColumns)) {
    const sessionId = extractSessionId(item.line);
    if (!sessionId) continue;
    cards.push({
      sessionId,
      line: item.line,
      column: item.column,
      basePrompt: extractBasePrompt(item.line, sessionId),
      taskId: extractCardMarker(item.line, "task"),
      attemptId: extractCardMarker(item.line, "attempt"),
      parentTaskId: extractCardMarker(item.line, "parent"),
    });
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Card Formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Obsidian Session Notes
// ---------------------------------------------------------------------------

/** Derive display status by combining session status with live activity state. */
function deriveDisplayStatus(session: Session): { display: string; emoji: string } {
  // Activity-based overrides take priority when they conflict with status
  if (session.activity === "waiting_input" || session.activity === "blocked") {
    return { display: "waiting for input", emoji: STATUS_EMOJI["needs_input"] ?? "⏸️" };
  }
  if (session.activity === "exited" && !DONE_STATUSES.has(session.status)) {
    return { display: "exited (crashed?)", emoji: "💀" };
  }
  if (session.activity === "active") {
    return { display: "actively working", emoji: STATUS_EMOJI["working"] ?? "🟢" };
  }
  if (session.activity === "idle" && !DONE_STATUSES.has(session.status)) {
    return { display: "idle", emoji: "💤" };
  }
  // Fall back to session status
  return {
    display: session.status.replace(/_/g, " "),
    emoji: STATUS_EMOJI[session.status] ?? "❓",
  };
}

/** Write/update an Obsidian markdown note for a session with full details. */
function writeSessionNote(
  workspacePath: string,
  sessionId: string,
  session: Session,
  basePrompt: string,
  config: OrchestratorConfig,
): void {
  const sessionsDir = join(workspacePath, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const notePath = join(sessionsDir, `${sessionId}.md`);
  const meta = session.metadata;
  const { display: displayStatus, emoji } = deriveDisplayStatus(session);
  const created = session.createdAt;
  const lastAct = session.lastActivityAt;
  const duration = formatDuration(created, lastAct);
  const agent = meta["agent"] ?? "unknown";
  const project = session.projectId || meta["project"] || "unknown";
  const boardProject = config.projects[project];
  const boardRef = boardProject?.boardDir ?? project;

  let md = `---\nsession: ${sessionId}\nproject: ${project}\nagent: ${agent}\nstatus: ${session.status}\n`;
  if (session.activity) md += `activity: ${session.activity}\n`;
  if (session.branch) md += `branch: ${session.branch}\n`;
  if (session.pr) md += `pr: ${session.pr.number}\n`;
  md += `created: ${created.toISOString()}\nupdated: ${lastAct.toISOString()}\n---\n\n`;

  md += `# ${emoji} ${basePrompt}\n\n`;

  // Overview table
  md += `| Field | Value |\n|-------|-------|\n`;
  md += `| **Session** | \`${sessionId}\` |\n`;
  md += `| **Project** | ${project} |\n`;
  md += `| **Agent** | ${agent} |\n`;
  md += `| **Status** | ${emoji} ${displayStatus} |\n`;
  if (session.activity) md += `| **Activity** | ${session.activity} |\n`;
  md += `| **Created** | ${created.toISOString().replace("T", " ").slice(0, 19)} |\n`;
  md += `| **Last Activity** | ${lastAct.toISOString().replace("T", " ").slice(0, 19)} |\n`;
  md += `| **Duration** | ${duration} |\n`;
  if (session.branch) md += `| **Branch** | \`${session.branch}\` |\n`;
  if (meta["worktree"]) md += `| **Worktree** | \`${meta["worktree"]}\` |\n`;
  if (meta["devServerLog"]) md += `| **Dev Server Log** | \`${meta["devServerLog"]}\` |\n`;
  md += `\n`;

  // Summary — prefer real agent summary; if fallback/noisy, synthesize from PR state.
  const rawSummary = session.agentInfo?.summary ?? meta["summary"];
  const normalizedSummary = rawSummary?.replace(/\s+/g, " ").trim();
  const isFallback =
    (session.agentInfo?.summaryIsFallback
      ?? /^(Codex|Claude)\s+session\s*\(/i.test(normalizedSummary ?? ""))
    || (normalizedSummary?.startsWith("You are an AI coding agent managed by Conductor") ?? false);

  let summaryToShow: string | null = null;
  if (normalizedSummary && !isFallback) {
    summaryToShow = normalizedSummary;
  } else if (session.pr) {
    const prTitle = session.pr.title || meta["prTitle"] || "";
    const prState = meta["prState"] ?? "open";
    const ciStatus = meta["ciStatus"] ?? "none";
    const reviewDecision = meta["reviewDecision"] ?? "none";
    summaryToShow = `PR #${session.pr.number}${prTitle ? ` — ${prTitle}` : ""}. State: ${prState}. CI: ${ciStatus}. Review: ${reviewDecision}.`;

    if (meta["mergeReadiness"]) {
      try {
        const readiness = JSON.parse(meta["mergeReadiness"]) as { blockers?: string[] };
        if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
          summaryToShow += ` Blockers: ${readiness.blockers.join("; ")}.`;
        }
      } catch {
        // ignore
      }
    }
  }

  if (summaryToShow) {
    md += `## Summary

${summaryToShow}

`;
  }


  // PR details
  if (session.pr) {
    const pr = session.pr;
    md += `## Pull Request\n\n`;
    md += `- **PR**: [#${pr.number} — ${pr.title}](${pr.url})\n`;
    md += `- **Branch**: \`${pr.branch}\` → \`${pr.baseBranch}\`\n`;
    if (pr.isDraft) md += `- **Draft**: yes\n`;

    const ciStatus = meta["ciStatus"] ?? "none";
    const reviewDecision = meta["reviewDecision"] ?? "none";
    const prState = meta["prState"] ?? "open";

    const ciEmoji = ciStatus === "passing" ? "✅" : ciStatus === "failing" ? "❌" : ciStatus === "pending" ? "⏳" : "—";
    const revEmoji = reviewDecision === "approved" ? "✅" : reviewDecision === "changes_requested" ? "🔄" : reviewDecision === "pending" ? "⏳" : "—";

    md += `- **State**: ${prState}\n`;
    md += `- **CI**: ${ciEmoji} ${ciStatus}\n`;
    md += `- **Review**: ${revEmoji} ${reviewDecision}\n`;

    // Merge readiness
    if (meta["mergeReadiness"]) {
      try {
        const readiness = JSON.parse(meta["mergeReadiness"]) as Record<string, unknown>;
        const check = (v: unknown): string => v ? "✅" : "❌";
        md += `\n### Merge Readiness\n\n`;
        md += `- ${check(readiness["mergeable"])} Mergeable\n`;
        md += `- ${check(readiness["ciPassing"])} CI Passing\n`;
        md += `- ${check(readiness["approved"])} Approved\n`;
        md += `- ${check(readiness["noConflicts"])} No Conflicts\n`;
        if (Array.isArray(readiness["blockers"]) && (readiness["blockers"] as string[]).length > 0) {
          md += `\n**Blockers:**\n`;
          for (const b of readiness["blockers"] as string[]) {
            md += `- ${b}\n`;
          }
        }
      } catch { /* ignore */ }
    }

    md += `\n`;
  }

  // Cost
  if (session.agentInfo?.cost || meta["cost"]) {
    md += `## Cost\n\n`;
    if (session.agentInfo?.cost) {
      const c = session.agentInfo.cost;
      md += `| Metric | Value |\n|--------|-------|\n`;
      if (c.inputTokens != null) md += `| Input Tokens | ${c.inputTokens.toLocaleString()} |\n`;
      if (c.outputTokens != null) md += `| Output Tokens | ${c.outputTokens.toLocaleString()} |\n`;
      if (c.estimatedCostUsd != null) md += `| Estimated Cost | $${c.estimatedCostUsd.toFixed(4)} |\n`;
    } else if (meta["cost"]) {
      try {
        const c = JSON.parse(meta["cost"]) as Record<string, number>;
        md += `| Metric | Value |\n|--------|-------|\n`;
        if (c["inputTokens"] != null) md += `| Input Tokens | ${c["inputTokens"].toLocaleString()} |\n`;
        if (c["outputTokens"] != null) md += `| Output Tokens | ${c["outputTokens"].toLocaleString()} |\n`;
        if (c["totalUSD"] != null) md += `| Estimated Cost | $${c["totalUSD"].toFixed(4)} |\n`;
      } catch { /* ignore */ }
    }
    md += `\n`;
  }

  // Links section
  md += `## Links\n\n`;
  if (session.pr) {
    md += `- [Pull Request #${session.pr.number}](${session.pr.url})\n`;
  }
  if (session.issueId) {
    md += `- Issue: ${session.issueId}\n`;
  }
  md += `- [[projects/${boardRef}/CONDUCTOR|Board]]\n`;
  md += `\n`;

  // Raw metadata
  md += `## Metadata\n\n`;
  md += `\`\`\`\n`;
  for (const [k, v] of Object.entries(meta).sort(([a], [b]) => a.localeCompare(b))) {
    if (k === "runtimeHandle") continue;
    md += `${k}=${v}\n`;
  }
  md += `\`\`\`\n`;

  writeFileSync(notePath, md, "utf-8");
}

/** Format a rich card line with live session state. */
function formatRichCardLine(
  basePrompt: string,
  sessionId: string,
  session: Session,
  opts?: { previewUrl?: string | null; dashboardUrl?: string },
): string {
  const { display: displayStatus, emoji } = deriveDisplayStatus(session);
  const agent = session.metadata["agent"] ?? "unknown";
  const isDone = DONE_STATUSES.has(session.status);

  let info = `${emoji} ${displayStatus} · ${agent}`;

  // Obsidian session note link (wiki-link for in-vault navigation)
  info += ` · [[sessions/${sessionId}|Details]]`;

  // Dashboard session link
  if (opts?.dashboardUrl) {
    const sessionUrl = `${opts.dashboardUrl}/sessions/${sessionId}`;
    info += ` · [Terminal](${sessionUrl})`;
  }

  // Duration — show for completed sessions
  if (isDone) {
    const duration = formatDuration(session.createdAt, session.lastActivityAt);
    info += ` · ⏱ ${duration}`;
  }

  // Cost — show for completed sessions
  if (isDone && session.agentInfo?.cost) {
    const cost = formatCost(session.agentInfo.cost.estimatedCostUsd);
    if (cost) info += ` · 💰 ${cost}`;
  }

  // PR link
  if (session.pr) {
    info += ` · [PR #${session.pr.number}](${session.pr.url})`;
  } else if (session.branch && !session.branch.startsWith("session/")) {
    // Skip redundant branch names like "session/pp-2" (same as session ID)
    info += ` · \`${session.branch}\``;
  }

  // CI / Review badges (from persisted metadata)
  const ciStatus = session.metadata["ciStatus"];
  if (ciStatus && ciStatus !== "none") {
    const ciEmoji = ciStatus === "passing" ? "✅" : ciStatus === "failing" ? "❌" : "⏳";
    info += ` · CI: ${ciEmoji}`;
  }
  const reviewDecision = session.metadata["reviewDecision"];
  if (reviewDecision && reviewDecision !== "none") {
    const revEmoji = reviewDecision === "approved" ? "✅" : reviewDecision === "changes_requested" ? "🔄" : "⏳";
    info += ` · Review: ${revEmoji}`;
  }

  // Preview URL
  if (opts?.previewUrl) {
    info += ` · [Preview](${opts.previewUrl})`;
  }

  // Summary — skip if it's just a duplicate of the base prompt
  const summary = session.agentInfo?.summary;
  if (summary) {
    // Card lines in Obsidian must stay single-line; collapse multiline agent summaries.
    const summarySingleLine = summary.replace(/\s+/g, " ").trim();
    // Don't show summary when it's essentially the same as the prompt text
    // (happens when summary falls back to first user message = our prompt)
    const promptNorm = basePrompt.toLowerCase().replace(/\s+/g, " ").trim();
    const summaryNorm = summarySingleLine.toLowerCase();
    const isDuplicate =
      summaryNorm.startsWith(promptNorm) ||
      promptNorm.startsWith(summaryNorm) ||
      (summaryNorm.length > 20 && promptNorm.includes(summaryNorm.slice(0, 40)));

    if (!isDuplicate) {
      const maxLen = isDone ? 120 : 60;
      const showFallback = isDone;
      if (!session.agentInfo?.summaryIsFallback || showFallback) {
        // Collapse newlines/markdown to single line — multi-line content
        // inside a kanban card breaks the Obsidian kanban parser.
        const flat = summary.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        const snippet = flat.length > maxLen ? flat.slice(0, maxLen - 3) + "..." : flat;
        info += ` · "${snippet}"`;
      }
    }
  }

  const markerSuffix = formatTaskMarkers({
    taskId: session.metadata["taskId"],
    attemptId: session.metadata["attemptId"],
    parentTaskId: session.metadata["parentTaskId"],
  });
  return `- [x] ${basePrompt}${markerSuffix ? ` ${markerSuffix}` : ""} [${sessionId}] — ${info}`;
}

/** Format a card for sessions that are no longer active (archived/killed). */
function formatCompletedCardLine(
  basePrompt: string,
  sessionId: string,
  markers?: { taskId?: string | null; attemptId?: string | null; parentTaskId?: string | null },
): string {
  const markerSuffix = formatTaskMarkers({
    taskId: markers?.taskId ?? undefined,
    attemptId: markers?.attemptId ?? undefined,
    parentTaskId: markers?.parentTaskId ?? undefined,
  });
  return `- [x] ${basePrompt}${markerSuffix ? ` ${markerSuffix}` : ""} [${sessionId}] — ✅ completed`;
}

// ---------------------------------------------------------------------------
// Card Movement (checked items)
// ---------------------------------------------------------------------------

/** Move a checked card between columns, optionally replacing its text. */
function moveCheckedCard(
  content: string,
  oldLine: string,
  fromColumn: string,
  toColumn: string,
  newLine?: string,
): string {
  return moveCardLine(content, oldLine, fromColumn, toColumn, newLine).content;
}

/** Replace a card line in-place (same column, text change only). */
function replaceCardLine(content: string, oldLine: string, newLine: string): string {
  return replaceLine(content, oldLine, newLine);
}

// ---------------------------------------------------------------------------
// Preview URL Detection (Netlify / Vercel)
// ---------------------------------------------------------------------------

/**
 * Fetch a deployment preview URL for a PR branch.
 * Checks GitHub commit statuses (Netlify) then deployments API (Vercel).
 */
async function fetchPreviewUrl(pr: PRInfo): Promise<string | null> {
  const { owner, repo, branch } = pr;
  if (!owner || !repo || !branch) return null;

  // 1. Try commit statuses — Netlify posts target_url here
  try {
    const { stdout } = await execFileP("gh", [
      "api", `repos/${owner}/${repo}/commits/${branch}/statuses`,
      "--jq", '[.[] | select(.context | test("(?i)netlify|vercel|deploy-preview|preview")) | .target_url][0] // empty',
    ], { timeout: 10_000 });
    const url = stdout.trim();
    if (url) return url;
  } catch { /* fall through */ }

  // 2. Try deployments API — Vercel creates Preview deployments
  try {
    const { stdout } = await execFileP("gh", [
      "api", `repos/${owner}/${repo}/deployments`,
      "--jq", '[.[] | select(.environment | test("(?i)preview")) | .id][0] // empty',
    ], { timeout: 10_000 });
    const deployId = stdout.trim();
    if (deployId) {
      const { stdout: statusOut } = await execFileP("gh", [
        "api", `repos/${owner}/${repo}/deployments/${deployId}/statuses`,
        "--jq", '.[0].environment_url // .[0].target_url // empty',
      ], { timeout: 10_000 });
      const deployUrl = statusOut.trim();
      if (deployUrl) return deployUrl;
    }
  } catch { /* fall through */ }

  return null;
}

// ---------------------------------------------------------------------------
// Dispatch Logic
// ---------------------------------------------------------------------------

/** Generate a hash for dedup tracking. */
function taskHash(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex");
}

function generateEntityId(prefix: "t" | "a"): string {
  return `${prefix}-${randomBytes(3).toString("hex")}`;
}

function normalizeHeadingForMatch(heading: string): string {
  return heading.trim().toLowerCase();
}

function resolveDispatchingColumn(
  headings: Set<string>,
  columns: ResolvedBoardColumns,
): string {
  const preferred = columns.columnsByRole.dispatching;
  if (headings.has(normalizeHeadingForMatch(preferred))) return preferred;

  const inProgress = columns.columnsByRole.inProgress;
  if (headings.has(normalizeHeadingForMatch(inProgress))) return inProgress;

  const review = columns.columnsByRole.review;
  if (headings.has(normalizeHeadingForMatch(review))) return review;

  const done = columns.columnsByRole.done;
  if (headings.has(normalizeHeadingForMatch(done))) return done;

  return preferred;
}

function resolveDoneColumn(
  headings: Set<string>,
  columns: ResolvedBoardColumns,
): string {
  const done = columns.columnsByRole.done;
  if (headings.has(normalizeHeadingForMatch(done))) return done;
  const review = columns.columnsByRole.review;
  if (headings.has(normalizeHeadingForMatch(review))) return review;
  const inProgress = columns.columnsByRole.inProgress;
  if (headings.has(normalizeHeadingForMatch(inProgress))) return inProgress;
  return columns.columnsByRole.ready;
}

function resolveTrackedColumns(
  headings: Set<string>,
  ...columns: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    if (!headings.has(normalizeHeadingForMatch(column))) continue;
    const normalized = normalizeHeadingForMatch(column);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(column);
  }
  return out;
}

function buildDispatchDedupeKey(params: {
  boardPath: string;
  projectId?: string;
  taskId?: string;
  prompt: string;
}): string {
  if (params.taskId) {
    return taskHash(`${params.taskId}|${params.prompt}`);
  }
  const scope = params.projectId ? `project:${params.projectId}` : `board:${params.boardPath}`;
  return taskHash(`${scope}|${params.prompt}`);
}

function ensureCardIds(card: ParsedCard): { taskId: string; attemptId: string } {
  return {
    taskId: card.taskId ?? generateEntityId("t"),
    attemptId: card.attemptId ?? generateEntityId("a"),
  };
}

function formatCardMetadataSuffix(card: ParsedCard, taskId: string, attemptId: string): string {
  const parts = [`[task:${taskId}]`, `[attempt:${attemptId}]`];
  if (card.parentTaskId) {
    parts.push(`[parent:${card.parentTaskId}]`);
  }
  return parts.join(" ");
}

/** Derive project ID from a board file path. */
function projectFromBoardPath(
  boardPath: string,
  config: OrchestratorConfig,
): string | undefined {
  // Project-specific boards: <workspace>/projects/<name>/CONDUCTOR.md
  const dir = dirname(boardPath);
  const dirName = basename(dir);

  // Check if dirName matches a single project key in config
  const directMatch = Object.keys(config.projects).filter((k) => k === dirName);
  if (directMatch.length === 1) return directMatch[0];

  // Check boardDir aliases — return undefined if multiple projects share the same board
  const boardDirMatches: string[] = [];
  for (const [key, project] of Object.entries(config.projects)) {
    if (project.boardDir && project.boardDir === dirName) boardDirMatches.push(key);
  }
  if (boardDirMatches.length === 1) return boardDirMatches[0];
  // Multiple projects share this board — caller must infer from task text
  if (boardDirMatches.length > 1) return undefined;

  // Legacy: first single match (shouldn't reach here)
  for (const [key, project] of Object.entries(config.projects)) {
    if (project.boardDir && project.boardDir === dirName) return key;
  }

  // Check if dirName matches a project path basename
  for (const [key, project] of Object.entries(config.projects)) {
    if (basename(project.path) === dirName) return key;
  }

  // Workspace-level board -- requires #project/ tag
  return undefined;
}

// ---------------------------------------------------------------------------
// Board Watcher
// ---------------------------------------------------------------------------

export interface BoardWatcher {
  start(): void;
  stop(): void;
  /** Manually check a specific board file. */
  checkBoard(boardPath: string): Promise<void>;
  /** Trigger immediate board state sync for all boards. Called by lifecycle on status change. */
  updateNow(): void;
}

/**
 * Options for syncing workspace support files used by note-takers and editors.
 */
export interface WorkspaceSupportFilesSyncOptions {
  workspacePath?: string;
  boardPaths?: string[];
  agentNames?: readonly string[];
  supportDirectories?: string[];
}

function resolveSupportDirectories(
  config: OrchestratorConfig,
  options: WorkspaceSupportFilesSyncOptions,
): string[] {
  const roots = new Set<string>();
  const workspace = options.workspacePath
    ?? process.env["CONDUCTOR_WORKSPACE"]
    ?? (config.configPath ? dirname(config.configPath) : process.cwd());

  roots.add(resolve(workspace));

  for (const project of Object.values(config.projects)) {
    if (typeof project.path !== "string" || project.path.trim().length === 0) continue;
    roots.add(resolve(project.path));
  }

  for (const boardPath of options.boardPaths ?? []) {
    roots.add(resolve(dirname(boardPath)));
  }

  for (const supportDirectory of options.supportDirectories ?? []) {
    if (supportDirectory.trim().length === 0) continue;
    roots.add(resolve(supportDirectory));
  }

  return [...roots];
}

function buildConductorTagsContent(config: OrchestratorConfig, agentNames: readonly string[]): string {
  const projectIds = Object.keys(config.projects).sort();
  const agents = uniqueAgents(agentNames.length > 0 ? agentNames : FALLBACK_WATCHER_AGENTS);
  const projectChoices = projectIds.length > 0 ? projectIds.join(",") : "my-project";
  const agentChoices = agents.length > 0 ? agents.join(",") : "codex,claude-code,gemini";

  // Build the markdown tag lines (one tag per project)
  const projectTagSeeds = projectIds.length > 0
    ? projectIds.map((id) => "#project/" + id).join(" ")
    : "#project/my-project";
  const agentTagSeeds = agents.map((a) => "#agent/" + a).join(" ");

  // Build table rows for projects
  const projectTableRows = projectIds.length > 0
    ? projectIds.map((id) => {
        const p = config.projects[id] as unknown as Record<string, unknown>;
        const desc = (p["description"] as string | undefined) ?? id;
        return "| `#project/" + id + "` | " + desc + " |";
      }).join("\n")
    : "| `#project/my-project` | Replace this after adding your first project |";

  const agentTableRows = agents
    .map((id) => `| \`#agent/${id}\` | ${id} agent plugin |`)
    .join("\n");

  const firstProject = projectIds[0] ?? "my-project";
  const secondProject = projectIds[1] ?? "my-project";
  const firstAgent = agents[0] ?? "codex";
  const secondAgent = agents[1] ?? "claude-code";

  const allTagsFrontmatter = [
    "  - conductor/reference",
    ...projectIds.map((id) => "  - project/" + id),
    ...agents.map((a) => "  - agent/" + a),
    "  - type/feature", "  - type/fix", "  - type/review", "  - type/chore", "  - type/docs",
    "  - priority/high", "  - priority/medium", "  - priority/low",
  ].join("\n");

  return [
    "---",
    "tags:",
    allTagsFrontmatter,
    "---",
    "",
    "# Conductor Tag Reference",
    "",
    "Quick-reference for tagging tasks in any `CONDUCTOR.md` board.",
    "Type `#` in Obsidian for autocomplete. Type `ctask` in VS Code for a full task snippet.",
    "",
    "> Auto-generated by conductor on startup. Add a project to `conductor.yaml` → it appears here automatically.",
    "",
    "---",
    "",
    "## Project Tags",
    "",
    "| Tag | Description |",
    "|-----|-------------|",
    projectTableRows,
    "",
    "---",
    "",
    "## Agent Tags",
    "",
    "| Tag | Uses |",
    "|-----|------|",
    ...agentTableRows.split("\n"),
    "",
    "---",
    "",
    "## Type Tags",
    "",
    "| Tag | Meaning |",
    "|-----|---------|",
    "| `#type/feature` | New feature or enhancement |",
    "| `#type/fix` | Bug fix |",
    "| `#type/review` | Code review or audit |",
    "| `#type/chore` | Maintenance / deps / config |",
    "| `#type/docs` | Documentation |",
    "",
    "---",
    "",
    "## Priority Tags",
    "",
    "| Tag | Meaning |",
    "|-----|---------|",
    "| `#priority/high` | Ship today |",
    "| `#priority/medium` | This sprint |",
    "| `#priority/low` | Nice to have |",
    "",
    "---",
    "",
    "## Example Task Formats",
    "",
    "```",
    "Fix login button tooltip #project/" + firstProject + " #agent/" + firstAgent + " #type/fix #priority/high",
    "",
    "Add analytics dashboard #project/" + secondProject + " #agent/" + secondAgent + " #type/feature",
    "```",
    "",
    "---",
    "",
    projectTagSeeds,
    agentTagSeeds,
    "#type/feature #type/fix #type/review #type/chore #type/docs",
    "#priority/high #priority/medium #priority/low",
    "",
  ].join("\n");
}

function buildConductorCodeSnippets(config: OrchestratorConfig, agentNames: readonly string[]): Record<string, unknown> {
  const projectIds = Object.keys(config.projects).sort();
  const agents = uniqueAgents(agentNames.length > 0 ? agentNames : FALLBACK_WATCHER_AGENTS);
  const projectChoices = projectIds.length > 0 ? projectIds.join(",") : "my-project";
  const agentChoices = agents.length > 0 ? agents.join(",") : "codex,claude-code,gemini";

  return {
    "Conductor Project Tag": {
      prefix: "#project",
      body: ["#project/${1|" + projectChoices + "|}"],
      description: "Route task to a Conductor project",
    },
    "Conductor Agent Tag": {
      prefix: "#agent",
      body: ["#agent/${1|" + agentChoices + "|}"],
      description: "Assign task to a specific agent",
    },
    "Conductor Type Tag": {
      prefix: "#type",
      body: ["#type/${1|feature,fix,review,chore,docs|}"],
      description: "Set task type",
    },
    "Conductor Priority Tag": {
      prefix: "#priority",
      body: ["#priority/${1|high,medium,low|}"],
      description: "Set task priority",
    },
      "Conductor Full Task": {
        prefix: "ctask",
        body: [
          "- [ ] ${1:Task description} #project/${2|" + projectChoices + "|} #agent/${3|" + agentChoices + "|} #type/${4|feature,fix,review,chore|} #priority/${5|high,medium,low|}",
        ],
        description: "Full Conductor task with all tags",
      },
  };
}

/**
 * Sync CONDUCTOR-TAGS.md and .vscode/conductor.code-snippets to every relevant
 * workspace/project directory from the current config.
 */
export function syncWorkspaceSupportFiles(
  config: OrchestratorConfig,
  options: WorkspaceSupportFilesSyncOptions = {},
): void {
  const agentNames = uniqueAgents(options.agentNames ?? FALLBACK_WATCHER_AGENTS);
  const supportDirectories = resolveSupportDirectories(config, options);
  const projectIds = Object.keys(config.projects).sort();
  const tagsContent = buildConductorTagsContent(config, agentNames);
  const snippetsJson = JSON.stringify(buildConductorCodeSnippets(config, agentNames), null, 2);

  let syncedCount = 0;

  for (const supportDirectory of supportDirectories) {
    try {
      if (!existsSync(supportDirectory) || !statSync(supportDirectory).isDirectory()) {
        continue;
      }

      writeFileSync(join(supportDirectory, "CONDUCTOR-TAGS.md"), tagsContent, "utf-8");
      const vscodeDir = join(supportDirectory, ".vscode");
      mkdirSync(vscodeDir, { recursive: true });
      writeFileSync(join(vscodeDir, "conductor.code-snippets"), snippetsJson, "utf-8");
      syncedCount += 1;
    } catch {
      // Non-fatal.
    }
  }

  if (syncedCount > 0) {
    console.log(
      "[board-watcher] Support files synced: "
      + syncedCount
      + " location(s), "
      + projectIds.length
      + " projects",
    );
  }
}


export function createBoardWatcher(watcherConfig: BoardWatcherConfig): BoardWatcher {
  const { config, sessionManager, boardPaths, onDispatch, onError } = watcherConfig;
  const dashboardUrl = watcherConfig.dashboardUrl ?? config.dashboardUrl;
  let configuredAgentNames: readonly string[] = FALLBACK_WATCHER_AGENTS;
  if (watcherConfig.agentNames && watcherConfig.agentNames.length > 0) {
    configuredAgentNames = watcherConfig.agentNames;
  }
  const supportedAgents = uniqueAgents(configuredAgentNames);
  const workspacePath = watcherConfig.workspacePath
    ?? process.env["CONDUCTOR_WORKSPACE"]
    ?? `${process.env["HOME"]}/.conductor/workspace`;
  const dispatchLogPath = join(workspacePath, "orchestrator", ".dispatched_tasks_v2");
  if (!existsSync(dirname(dispatchLogPath))) {
    mkdirSync(dirname(dispatchLogPath), { recursive: true });
  }
  const dispatched = new Set<string>(
    existsSync(dispatchLogPath)
      ? readFileSync(dispatchLogPath, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [],
  );
  const watchers: ReturnType<typeof fsWatch>[] = [];
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** Lock to prevent concurrent dispatch on the same board. */
  const boardLocks = new Map<string, Promise<void>>();

  /** Cache for deployment preview URLs — avoids hammering GitHub API every 15s. */
  const previewUrlCache = new Map<string, { url: string | null; checkedAt: number }>();

  /** Re-check interval for missing preview URLs (2 minutes). */
  const PREVIEW_RECHECK_MS = 120_000;

  /** Max cache entries before evicting oldest. */
  const MAX_PREVIEW_CACHE = 200;
  const MAX_DISPATCHED = 5000;
  const debugEnabled = process.env["CONDUCTOR_DEBUG"] === "1";

  function log(msg: string, boardPath?: string): void {
    console.log(`[board-watcher] ${msg}`);
    recordWatcherAction(workspacePath, {
      level: "info",
      action: msg,
      boardPath,
    });
  }

  function trace(msg: string, boardPath?: string): void {
    if (!debugEnabled) return;
    console.log(`[board-watcher][debug] ${msg}`);
    recordWatcherAction(workspacePath, {
      level: "debug",
      action: msg,
      boardPath,
    });
  }

  function logError(err: Error, context: string, boardPath?: string): void {
    console.error(`[board-watcher] ${context}: ${err.message}`);
    recordWatcherAction(workspacePath, {
      level: "error",
      action: `${context}: ${err.message}`,
      boardPath,
      context,
    });
    onError?.(err, context);
  }

  function resolveBoardColumns(boardPath: string, content: string) {
    const aliases = resolveBoardAliasesForPath(config, workspacePath, boardPath);
    return resolveColumnsFromBoard(content, aliases);
  }

  async function dispatchTask(
    boardPath: string,
    card: ParsedCard,
    boardProjectId: string | undefined,
    ids: { taskId: string; attemptId: string },
  ): Promise<{ sessionId: string; taskId: string; attemptId: string } | null> {
    // Determine project — prefer explicit tag, fall back to board path inference
    const projectId = card.project ?? boardProjectId;
    if (!projectId) {
      log(`Skipping task (no project): "${card.prompt}"`);
      return null;
    }

    if (!config.projects[projectId]) {
      log(`Unknown project "${projectId}" in task: "${card.prompt}"`);
      return null;
    }

    // Determine agent (normalize aliases: #agent/claude -> claude-code)
    const agent = normalizeAgent(
      card.agent ?? autoDetectAgent(card.prompt, supportedAgents),
      supportedAgents,
    );
    if (card.agent && normalizeAgentName(card.agent, supportedAgents) !== normalizeAgentName(agent, supportedAgents)) {
      log(`Normalized agent tag for dispatch: "${card.agent}" -> "${agent}"`, boardPath);
    }

    // Build the prompt/issue
    if (card.attachments.length > 0) {
      log(`  Attachments: ${card.attachments.map((a) => `${a.type}:${basename(a.path)}`).join(", ")}`, boardPath);
    }
    trace(
      `Dispatch metadata task=${ids.taskId} attempt=${ids.attemptId}` +
        `${card.parentTaskId ? ` parent=${card.parentTaskId}` : ""}` +
        `${card.profile ? ` profile=${card.profile}` : ""}`,
      boardPath,
    );
    log(
      `Dispatching [${agent}${card.model ? ` model=${card.model}` : ""}] -> ${projectId}: "${card.prompt}"`,
      boardPath,
    );

    try {
      const session: Session = await sessionManager.spawn({
        projectId,
        issueId: card.issueId,
        prompt: card.prompt || undefined,
        agent,
        model: card.model,
        profile: card.profile,
        taskId: ids.taskId,
        attemptId: ids.attemptId,
        parentTaskId: card.parentTaskId,
        attachments: card.attachments.length > 0 ? card.attachments : undefined,
      });

      log(`Spawned session ${session.id} for "${card.prompt}"`, boardPath);
      onDispatch?.(projectId, session.id, card.prompt);
      return { sessionId: session.id, taskId: ids.taskId, attemptId: ids.attemptId };
    } catch (err) {
      logError(
        err instanceof Error ? err : new Error(String(err)),
        `spawn for "${card.prompt}"`,
        boardPath,
      );
      return null;
    }
  }

  async function checkBoard(boardPath: string): Promise<void> {
    if (!existsSync(boardPath)) return;

    const preContent = readFileSync(boardPath, "utf-8");
    const guardCheck = writeGuard.get(boardPath);
    if (guardCheck && Date.now() - guardCheck.at < WRITE_GUARD_MS && preContent === guardCheck.content) {
      return; // Ignore only our own just-written content during cooldown
    }

    // Serialize: if a check is already running for this board, wait for it then skip
    const existing = boardLocks.get(boardPath);
    if (existing) { await existing; return; }

    let resolve!: () => void;
    const lock = new Promise<void>((res) => { resolve = res; });
    boardLocks.set(boardPath, lock);

    try {
      const content = readFileSync(boardPath, "utf-8");
      const resolvedColumns = resolveBoardColumns(boardPath, content);
      const readyColumn = resolvedColumns.columnsByRole.ready;
      const headingSet = new Set(resolvedColumns.headings.map(normalizeHeadingForMatch));
      const dispatchingColumn = resolveDispatchingColumn(headingSet, resolvedColumns);
      const trackedColumns = resolveTrackedColumns(
        headingSet,
        dispatchingColumn,
        resolvedColumns.columnsByRole.inProgress,
        resolvedColumns.columnsByRole.review,
        resolvedColumns.columnsByRole.blocked,
        resolvedColumns.columnsByRole.done,
      );
      const trackedColumnsSeed = trackedColumns.length > 0 ? trackedColumns : [readyColumn];
      const boardProjectId = projectFromBoardPath(boardPath, config);
      const tasks = getColumnTasks(content, readyColumn);
      trace(`Parse ${boardPath}: ready=${readyColumn} tasks=${tasks.length}`, boardPath);
      if (tasks.length === 0) return;

      let updatedContent = content;
      let anyDispatched = false;

      for (const taskText of tasks) {
        const card = parseCard(taskText, workspacePath);
        const { taskId, attemptId } = ensureCardIds(card);
        const promptHash = buildDispatchDedupeKey({
          boardPath,
          projectId: boardProjectId,
          taskId: card.taskId,
          prompt: card.prompt,
        });
        if (dispatched.has(promptHash)) continue;

        // Restart-safe dedupe: if a tracked card with the same task OR same base
        // prompt already exists, skip re-dispatching.
        const existingTracked = getAllTrackedCards(updatedContent, trackedColumnsSeed).some(
          (tracked) => card.taskId
            ? tracked.taskId === card.taskId
            : tracked.basePrompt === card.prompt,
        );
        if (existingTracked) {
          dispatched.add(promptHash);
          continue;
        }

        // Mark as dispatched immediately to prevent re-entry
        dispatched.add(promptHash);

        const result = await dispatchTask(boardPath, card, boardProjectId, { taskId, attemptId });

        if (result) {
          // Persist hash to survive process restarts / external board rewrites.
          try {
            appendFileSync(dispatchLogPath, `${promptHash}\n`, "utf-8");
          } catch {
            // Non-fatal
          }
          // Move card: Ready to Dispatch -> Dispatching (with session ID)
          const metadataSuffix = formatCardMetadataSuffix(card, result.taskId, result.attemptId);
          const newCardText = `${card.prompt} ${metadataSuffix} [${result.sessionId}]`;
          const moved = moveCard(updatedContent, taskText, readyColumn, dispatchingColumn, newCardText);
          updatedContent = moved.content;
          anyDispatched = moved.moved;
        } else {
          // Failed to dispatch -- remove from dispatched set so it retries
          dispatched.delete(promptHash);
        }
      }

      if (anyDispatched && updatedContent !== content) {
        writeFileSync(boardPath, updatedContent, "utf-8");
        writeGuard.set(boardPath, { content: updatedContent, at: Date.now() });
        log(`Board updated: ${boardPath}`, boardPath);
        nudgeObsidian(boardPath);
      }

      // Cap dispatched set size to prevent unbounded memory growth
      if (dispatched.size > MAX_DISPATCHED) {
        const excess = dispatched.size - MAX_DISPATCHED;
        let removed = 0;
        for (const hash of dispatched) {
          if (removed >= excess) break;
          dispatched.delete(hash);
          removed++;
        }
      }
    } catch (err) {
      logError(err instanceof Error ? err : new Error(String(err)), `checkBoard ${boardPath}`, boardPath);
    } finally {
      boardLocks.delete(boardPath);
      resolve();
    }
  }

  /** Periodically update tracked cards with live session state and move between columns. */
  async function updateBoardState(boardPath: string): Promise<void> {
    if (!existsSync(boardPath)) return;
    const existingState = boardLocks.get(boardPath);
    if (existingState) { await existingState; return; }

    let resolveState!: () => void;
    const stateLock = new Promise<void>((res) => { resolveState = res; });
    boardLocks.set(boardPath, stateLock);

    try {
      let content = readFileSync(boardPath, "utf-8");
      const resolvedColumns = resolveBoardColumns(boardPath, content);
      const headingSet = new Set(resolvedColumns.headings.map(normalizeHeadingForMatch));
      const trackedColumns = resolveTrackedColumns(
        headingSet,
        resolvedColumns.columnsByRole.dispatching,
        resolvedColumns.columnsByRole.inProgress,
        resolvedColumns.columnsByRole.review,
        resolvedColumns.columnsByRole.blocked,
        resolvedColumns.columnsByRole.done,
      );
      const doneColumn = resolveDoneColumn(headingSet, resolvedColumns);
      const boardProjectId = projectFromBoardPath(boardPath, config);

      // During guard window, ignore only our own just-written content.
      const guard = writeGuard.get(boardPath);
      if (guard && Date.now() - guard.at < WRITE_GUARD_MS && content === guard.content) {
        return;
      }
      const trackedCards = getAllTrackedCards(content, trackedColumns);
      if (trackedCards.length === 0) return;

      // Fetch all active sessions in one call
      let sessions: Session[];
      try {
        sessions = await sessionManager.list();
      } catch (err) {
        logError(
          err instanceof Error ? err : new Error(String(err)),
          "updateBoardState list()",
        );
        return;
      }
      const sessionMap = new Map(sessions.map((s) => [s.id, s]));

      // Fetch preview URLs for sessions with PRs (cached, rate-limited)
      const previewUrls = new Map<string, string | null>();
      for (const card of trackedCards) {
        const session = sessionMap.get(card.sessionId);
        if (!session?.pr) continue;

        const cacheKey = card.sessionId;
        const cached = previewUrlCache.get(cacheKey);
        if (cached) {
          if (cached.url) {
            previewUrls.set(card.sessionId, cached.url);
          } else if (Date.now() - cached.checkedAt < PREVIEW_RECHECK_MS) {
            // Not found recently — skip re-fetch
            continue;
          }
        }

        if (!previewUrls.has(card.sessionId)) {
          try {
            const url = await fetchPreviewUrl(session.pr);
            previewUrlCache.set(cacheKey, { url, checkedAt: Date.now() });
            if (url) {
              previewUrls.set(card.sessionId, url);
              log(`Preview URL for [${card.sessionId}]: ${url}`, boardPath);
            }
          } catch {
            previewUrlCache.set(cacheKey, { url: null, checkedAt: Date.now() });
          }
        }
      }

      // Evict stale preview cache entries (older than 10 min) to bound memory
      const now = Date.now();
      if (previewUrlCache.size > MAX_PREVIEW_CACHE) {
        const staleThreshold = now - 600_000;
        for (const [key, entry] of previewUrlCache) {
          if (entry.checkedAt < staleThreshold) previewUrlCache.delete(key);
        }
      }

      let updated = content;
      let changed = false;

      for (const card of trackedCards) {
        const session = sessionMap.get(card.sessionId);

        if (!session) {
          // Session no longer active (archived/killed). Normalize to a stable
          // completed card line so stale "actively working" text does not linger.
          const completedLine = formatCompletedCardLine(card.basePrompt, card.sessionId, {
            taskId: card.taskId,
            attemptId: card.attemptId,
            parentTaskId: card.parentTaskId,
          });
          if (card.column !== doneColumn) {
            updated = moveCheckedCard(updated, card.line, card.column, doneColumn, completedLine);
            changed = true;
            log(`Card [${card.sessionId}] ${card.column} → ${doneColumn} (session archived)`, boardPath);
          } else if (card.line !== completedLine) {
            updated = replaceCardLine(updated, card.line, completedLine);
            changed = true;
          }
          // Allow re-dispatch if user moves card back to Ready to Dispatch
          const dedupeKey = buildDispatchDedupeKey({
            boardPath,
            projectId: boardProjectId,
            taskId: card.taskId ?? undefined,
            prompt: card.basePrompt,
          });
          dispatched.delete(dedupeKey);
          continue;
        }

        // Write/update Obsidian session note with full details
        try {
          writeSessionNote(workspacePath, card.sessionId, session, card.basePrompt, config);
        } catch (err) {
          logError(
            err instanceof Error ? err : new Error(String(err)),
            `writeSessionNote ${card.sessionId}`,
            boardPath,
          );
        }

        const targetRole = statusToColumnRole(session.status);
        const targetColumn = resolveTrackedColumns(
          headingSet,
          resolvedColumns.columnsByRole[targetRole],
        )[0];
        const preview = previewUrls.get(card.sessionId) ?? null;
        const newLine = formatRichCardLine(card.basePrompt, card.sessionId, session, {
          previewUrl: preview,
          dashboardUrl,
        });

        if (!targetColumn) {
          // Column unavailable on this board layout — keep card text current in-place.
          if (!DONE_STATUSES.has(session.status) && card.line !== newLine) {
            updated = replaceCardLine(updated, card.line, newLine);
            changed = true;
          }
          continue;
        }

        if (targetColumn !== card.column) {
          // Move to correct column with updated text
          updated = moveCheckedCard(updated, card.line, card.column, targetColumn, newLine);
          changed = true;
          log(`Card [${card.sessionId}] ${card.column} → ${targetColumn} (${session.status})`, boardPath);
        } else if (card.line !== newLine) {
          // Same column — update card text in place.
          // Skip churn for terminal sessions (done/merged/etc.) to avoid
          // rewriting Obsidian files every poll tick due drifting timestamps.
          if (!DONE_STATUSES.has(session.status)) {
            updated = replaceCardLine(updated, card.line, newLine);
            changed = true;
          }
        }
      }

      if (changed && updated !== content) {
        writeFileSync(boardPath, updated, "utf-8");
        writeGuard.set(boardPath, { content: updated, at: Date.now() });
        nudgeObsidian(boardPath);
        log(`Board state updated: ${boardPath}`, boardPath);
      }
    } catch (err) {
      logError(
        err instanceof Error ? err : new Error(String(err)),
        `updateBoardState ${boardPath}`,
        boardPath,
      );
    } finally {
      boardLocks.delete(boardPath);
      resolveState();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      log(`Watching ${boardPaths.length} board(s)`);
      for (const bp of boardPaths) {
        log(`  - ${bp}`);
      }

      // Use Node.js fs.watch for each board file
      for (const boardPath of boardPaths) {
        if (!existsSync(boardPath)) {
          log(`Board not found (skipping): ${boardPath}`);
          continue;
        }

        try {
          const watcher = fsWatch(boardPath, { persistent: false }, (eventType) => {
            if (eventType === "change") {
              // Debounce: wait 2s for Obsidian to finish its write cycle
              setTimeout(() => {
      void enhanceInbox(boardPath, config, supportedAgents);
                void checkBoard(boardPath);
              }, 2000);
            }
          });

          watcher.on("error", (err) => {
            logError(err, `fs.watch ${boardPath}`);
          });

          watchers.push(watcher);
        } catch (err) {
          logError(err instanceof Error ? err : new Error(String(err)), `watch setup ${boardPath}`);
        }
      }

      syncWorkspaceSupportFiles(config, {
        workspacePath,
        boardPaths,
        agentNames: supportedAgents,
      });

      // Run initial inbox enhancement 3s after startup
      setTimeout(() => {
        for (const boardPath of boardPaths) {
          void enhanceInbox(boardPath, config, supportedAgents);
        }
      }, 3_000);

      // Run initial board check 2s after startup so existing "Ready to Dispatch"
      // tasks are dispatched without waiting for a file change event.
      setTimeout(() => {
        for (const boardPath of boardPaths) {
          void checkBoard(boardPath);
        }
      }, 2000);

      // Fallback poll in case fs.watch misses events (common on macOS + Obsidian).
      // Run continuously so we don't rely on file event timing quirks.
      const pollMs = watcherConfig.pollIntervalMs ?? 2000;

      pollInterval = setInterval(() => {
        for (const boardPath of boardPaths) {
          if (!existsSync(boardPath)) continue;
          void enhanceInbox(boardPath, config, supportedAgents);
          void checkBoard(boardPath);
        }
      }, pollMs);

      // Session state update loop — enriches cards with live status
      updateInterval = setInterval(() => {
        for (const boardPath of boardPaths) {
          void updateBoardState(boardPath);
        }
      }, 5_000);

      // Run initial state update after 3s (let first dispatch cycle complete)
      setTimeout(() => {
        for (const boardPath of boardPaths) {
          void updateBoardState(boardPath);
        }
      }, 3_000);
    },

    updateNow(): void {
      for (const boardPath of boardPaths) {
        void updateBoardState(boardPath);
      }
    },

    stop(): void {
      running = false;
      for (const w of watchers) {
        w.close();
      }
      watchers.length = 0;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }

      // Release cached data
      previewUrlCache.clear();
      boardLocks.clear();
      log("Stopped");
    },

    checkBoard,
  };
}

// ---------------------------------------------------------------------------
// Helpers for discovering boards
// ---------------------------------------------------------------------------

/** Find all CONDUCTOR.md boards in the workspace. */
export function discoverBoards(
  workspacePath: string,
  boardPathsOrConfig?: readonly BoardConfigEntry[] | OrchestratorConfig,
): string[] {
  const boards = new Set<string>();
  const legacyConfig: OrchestratorConfig | undefined = isOrchestratorConfig(boardPathsOrConfig)
    ? boardPathsOrConfig
    : undefined;
  if (Array.isArray(boardPathsOrConfig)) {
    if (boardPathsOrConfig.length === 0) {
      const legacyBoards = discoverBoardsLegacy(workspacePath);
      for (const board of legacyBoards) {
        boards.add(board);
      }
      return [...boards];
    }

    for (const boardPatternEntry of boardPathsOrConfig) {
      const boardPatternRaw = typeof boardPatternEntry === "string"
        ? boardPatternEntry
        : boardPatternEntry.path;
      const boardPattern = boardPatternRaw.trim();
      if (!boardPattern) continue;

      const resolvedPattern = resolveBoardPattern(boardPattern);
      const matches = resolveBoardPatternToFiles(
        resolvedPattern,
        workspacePath,
        isAbsolutePath(resolvedPattern),
      );
      for (const match of matches) {
        boards.add(match);
      }
    }
    return [...boards];
  }

  const legacyBoards = discoverBoardsLegacy(workspacePath, legacyConfig);
  for (const board of legacyBoards) {
    boards.add(board);
  }
  return [...boards];
}

/** Legacy behavior: discover workspace CONDUCTOR.md + project CONDUCTOR.md files. */
function discoverBoardsLegacy(workspacePath: string, config?: OrchestratorConfig): string[] {
  const boards: string[] = [];
  const seen = new Set<string>();

  const addBoard = (path: string): void => {
    if (!existsSync(path)) return;
    if (seen.has(path)) return;
    seen.add(path);
    boards.push(path);
  };

  // Workspace-level board
  addBoard(join(workspacePath, "CONDUCTOR.md"));

  const isKanbanBoardFile = (path: string): boolean => {
    if (!existsSync(path)) return false;
    try {
      const content = readFileSync(path, "utf-8");
      return /(?:^|\n)\s*kanban-plugin:\s*board\s*(?:$|\n)/i.test(content);
    } catch {
      return false;
    }
  };

  const collectKanbanMarkdown = (rootDir: string, maxDepth: number): void => {
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir, { encoding: "utf-8" });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, depth + 1);
            continue;
          }
          if (!st.isFile()) continue;
          if (!entry.toLowerCase().endsWith(".md")) continue;
          if (isKanbanBoardFile(full)) addBoard(full);
        } catch {
          // Ignore transient entries
        }
      }
    };

    walk(rootDir, 0);
  };

  // Project-level boards under workspace/projects
  const projectsDir = join(workspacePath, "projects");
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir)) {
        const full = join(projectsDir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            addBoard(join(full, "CONDUCTOR.md"));
            collectKanbanMarkdown(full, 2);
          } else if (st.isFile() && entry.toLowerCase().endsWith(".md") && isKanbanBoardFile(full)) {
            addBoard(full);
          }
        } catch {
          // Ignore entries that disappear between readdir and stat
        }
      }
    } catch {
      // Can't read projects dir
    }
  }

  // Also watch repo-local boards from configured project.path values.
  // This covers cases where users edit nested board files in project repos.
  if (config) {
    for (const project of Object.values(config.projects)) {
      const projectRoot = expandHome(project.path);
      addBoard(join(projectRoot, "CONDUCTOR.md"));
      collectKanbanMarkdown(projectRoot, 2);
    }
  }

  return boards;
}


/** Expand ~ to home directory. */
function expandHome(filepath: string): string {
  if (!filepath.startsWith("~/")) {
    return filepath;
  }

  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) {
    return filepath;
  }

  return join(home, filepath.slice(2));
}

/** Convert a workspace-relative or explicit board path into a normalized pattern path. */
function resolveBoardPattern(boardPattern: string): string {
  const expanded = expandHome(boardPattern);
  if (isAbsolutePath(expanded)) {
    return expanded;
  }

  return expanded;
}

function isAbsolutePath(pathname: string): boolean {
  return (
    pathname.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(pathname)
  );
}

function isGlobPattern(pathname: string): boolean {
  return pathname.includes("*") || pathname.includes("?") || pathname.includes("[");
}

function segmentToRegex(segment: string): RegExp {
  if (!segment.includes("*") && !segment.includes("?") && !segment.includes("[")) {
    return new RegExp(`^${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  }

  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, "[^/\\\\]");
  return new RegExp(`^${escaped}$`);
}

function walkGlob(
  currentDir: string,
  segments: readonly string[],
  index: number,
  hits: Set<string>,
): void {
  if (index >= segments.length) {
    if (existsSync(currentDir)) {
      hits.add(currentDir);
    }
    return;
  }

  const segment = segments[index];
  if (segment === "**") {
    walkGlob(currentDir, segments, index + 1, hits);

    let entries: { name: string; isDirectory: boolean }[] = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, isDirectory: true }));
    } catch {
      return;
    }

    for (const entry of entries) {
      walkGlob(join(currentDir, entry.name), segments, index, hits);
    }
    return;
  }

  let dirEntries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  try {
    dirEntries = readdirSync(currentDir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
  } catch {
    return;
  }

  const matcher = segmentToRegex(segment);
  const isFinalSegment = index === segments.length - 1;

  for (const entry of dirEntries) {
    if (!matcher.test(entry.name)) continue;
    const candidate = join(currentDir, entry.name);

    if (isFinalSegment) {
      if (!entry.isDirectory) {
        hits.add(candidate);
      }
      continue;
    }

    if (entry.isDirectory) {
      walkGlob(candidate, segments, index + 1, hits);
    }
  }
}

function resolveBoardPatternToFiles(
  patternPath: string,
  workspacePath: string,
  isAbsolute = false,
): string[] {
  const absolutePattern = isAbsolute
    ? patternPath
    : join(workspacePath, patternPath);

  if (!isGlobPattern(absolutePattern)) {
    if (existsSync(absolutePattern) && statSync(absolutePattern).isFile()) {
      return [absolutePattern];
    }
    return [];
  }

  const parts = isAbsolute
    ? splitAbsolutePattern(absolutePattern).parts
    : patternPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const rootDir = isAbsolute ? splitAbsolutePattern(absolutePattern).root : workspacePath;

  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    return [];
  }

  const hits = new Set<string>();
  walkGlob(rootDir, parts, 0, hits);

  return [...hits];
}

function splitAbsolutePattern(patternPath: string): { root: string; parts: string[] } {
  if (/^[A-Za-z]:\//.test(patternPath)) {
    return { root: patternPath.slice(0, 3), parts: patternPath.slice(3).split("/").filter(Boolean) };
  }

  if (patternPath.startsWith("/")) {
    return { root: "/", parts: patternPath.slice(1).split("/").filter(Boolean) };
  }

  return { root: "", parts: patternPath.split("/").filter(Boolean) };
}

/** Narrowing helper for overloaded discoverBoards parameter. */
function isOrchestratorConfig(value: unknown): value is OrchestratorConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "projects" in value && "defaults" in value;
}

/** Build the board-to-project mapping for a config. */
export function buildBoardProjectMap(
  boards: string[],
  config: OrchestratorConfig,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const boardPath of boards) {
    const projectId = projectFromBoardPath(boardPath, config);
    if (projectId) {
      map.set(boardPath, projectId);
    }
  }
  return map;
}
