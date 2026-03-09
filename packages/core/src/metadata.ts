/**
 * Flat-file metadata read/write.
 *
 * Architecture:
 * - Session metadata stored in project-specific directories
 * - Path: ~/.conductor/{hash}-{projectId}/sessions/{sessionName}
 * - Session files use user-facing names (int-1) not tmux names (a3b4c5d6e7f8-int-1)
 * - Metadata includes tmuxName field to map user-facing -> tmux name
 *
 * Format: key=value pairs (one per line), compatible with bash scripts
 *
 * Example file contents:
 *   project=my-app
 *   worktree=/Users/foo/.conductor/a3b4c5d6e7f8-my-app/worktrees/ma-1
 *   branch=feat/INT-1234
 *   status=working
 *   tmuxName=a3b4c5d6e7f8-ma-1
 *   pr=https://github.com/org/repo/pull/42
 *   issue=INT-1234
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { join, dirname } from "node:path";
import type { ConversationEntry, SessionId, SessionMetadata } from "./types.js";

/**
 * Parse a key=value metadata file into a record.
 * Lines starting with # are comments. Empty lines are skipped.
 * Only the first `=` is used as the delimiter (values can contain `=`).
 */
function parseMetadataFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Serialize a record back to key=value format. */

/** Ensure metadata values stay single-line key=value safe. */
function sanitizeMetadataValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function serializeMetadata(data: Record<string, string>): string {
  return (
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${sanitizeMetadataValue(v)}`)
      .join("\n") + "\n"
  );
}

/** Validate sessionId to prevent path traversal. */
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: SessionId): void {
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

/** Get the metadata file path for a session. */
function metadataPath(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, sessionId);
}

function conversationPath(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, "conversation", `${sessionId}.jsonl`);
}

/**
 * Read raw metadata as a string record (for arbitrary keys).
 * Returns null if the file doesn't exist.
 */
export function readMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;
  return parseMetadataFile(readFileSync(path, "utf-8"));
}

/**
 * Write full metadata for a session (overwrites existing file).
 */
export function writeMetadata(
  dataDir: string,
  sessionId: SessionId,
  metadata: SessionMetadata,
): void {
  const path = metadataPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });

  const data: Record<string, string> = {
    worktree: metadata.worktree,
    branch: metadata.branch,
    status: metadata.status,
  };

  if (metadata.tmuxName) data["tmuxName"] = metadata.tmuxName;
  if (metadata.issue) data["issue"] = metadata.issue;
  if (metadata.pr) data["pr"] = metadata.pr;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.agent) data["agent"] = metadata.agent;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = metadata.runtimeHandle;
  if (metadata.restoredAt) data["restoredAt"] = metadata.restoredAt;
  if (metadata.role) data["role"] = metadata.role;
  if (metadata.ciStatus) data["ciStatus"] = metadata.ciStatus;
  if (metadata.reviewDecision) data["reviewDecision"] = metadata.reviewDecision;
  if (metadata.prState) data["prState"] = metadata.prState;
  if (metadata.mergeReadiness) data["mergeReadiness"] = metadata.mergeReadiness;
  if (metadata.prTitle) data["prTitle"] = metadata.prTitle;
  if (metadata.prHeadRef) data["prHeadRef"] = metadata.prHeadRef;
  if (metadata.prBaseRef) data["prBaseRef"] = metadata.prBaseRef;
  if (metadata.prDraft) data["prDraft"] = metadata.prDraft;
  if (metadata.cost) data["cost"] = metadata.cost;
  if (metadata.model) data["model"] = metadata.model;
  if (metadata.reasoningEffort) data["reasoningEffort"] = metadata.reasoningEffort;
  if (metadata.permissions) data["permissions"] = metadata.permissions;
  if (metadata.taskId) data["taskId"] = metadata.taskId;
  if (metadata.attemptId) data["attemptId"] = metadata.attemptId;
  if (metadata.parentTaskId) data["parentTaskId"] = metadata.parentTaskId;
  if (metadata.attemptStatus) data["attemptStatus"] = metadata.attemptStatus;
  if (metadata.retryOfSessionId) data["retryOfSessionId"] = metadata.retryOfSessionId;
  if (metadata.supersededByAttemptId) data["supersededByAttemptId"] = metadata.supersededByAttemptId;
  if (metadata.profile) data["profile"] = metadata.profile;
  if (metadata.baseBranch) data["baseBranch"] = metadata.baseBranch;
  if (metadata.prompt) data["prompt"] = metadata.prompt;
  if (metadata.devServerLog) data["devServerLog"] = metadata.devServerLog;
  if (metadata.devServerUrl) data["devServerUrl"] = metadata.devServerUrl;
  if (metadata.devServerPort) data["devServerPort"] = metadata.devServerPort;

  writeFileSync(path, serializeMetadata(data), "utf-8");
}

/**
 * Update specific fields in a session's metadata.
 * Reads existing file, merges updates, writes back.
 */
export function updateMetadata(
  dataDir: string,
  sessionId: SessionId,
  updates: Partial<Record<string, string>>,
): void {
  const path = metadataPath(dataDir, sessionId);
  let existing: Record<string, string> = {};

  if (existsSync(path)) {
    existing = parseMetadataFile(readFileSync(path, "utf-8"));
  }

  // Merge updates -- remove keys set to empty string
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _, ...rest } = existing;
      existing = rest;
    } else {
      existing[key] = sanitizeMetadataValue(value);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMetadata(existing), "utf-8");
}

function normalizeConversationEntry(entry: ConversationEntry): ConversationEntry {
  const normalized: ConversationEntry = {
    id: sanitizeMetadataValue(entry.id),
    sessionId: sanitizeMetadataValue(entry.sessionId),
    kind: entry.kind,
    text: entry.text.trim(),
    createdAt: sanitizeMetadataValue(entry.createdAt),
  };

  const attachments = (entry.attachments ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (attachments.length > 0) {
    normalized.attachments = [...new Set(attachments)];
  }
  if (entry.model?.trim()) normalized.model = entry.model.trim();
  if (entry.reasoningEffort?.trim()) normalized.reasoningEffort = entry.reasoningEffort.trim().toLowerCase();
  if (entry.source?.trim()) normalized.source = entry.source;
  return normalized;
}

export function appendConversationEntry(
  dataDir: string,
  sessionId: SessionId,
  entry: ConversationEntry,
): void {
  const path = conversationPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeConversationEntry(entry))}\n`, {
    encoding: "utf-8",
    flag: "a",
  });
}

export function readConversationEntries(
  dataDir: string,
  sessionId: SessionId,
): ConversationEntry[] {
  const path = conversationPath(dataDir, sessionId);
  if (!existsSync(path)) return [];

  const entries: ConversationEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ConversationEntry>;
      if (
        typeof parsed.id !== "string"
        || typeof parsed.sessionId !== "string"
        || (parsed.kind !== "user_message" && parsed.kind !== "system_message")
        || typeof parsed.text !== "string"
        || typeof parsed.createdAt !== "string"
      ) {
        continue;
      }
      entries.push(normalizeConversationEntry(parsed as ConversationEntry));
    } catch {
      // Ignore malformed lines.
    }
  }
  return entries;
}

export function readArchivedConversationEntries(
  dataDir: string,
  sessionId: SessionId,
): ConversationEntry[] {
  validateSessionId(sessionId);
  const archiveDir = join(dataDir, "archive");
  if (!existsSync(archiveDir)) return [];

  const prefix = `${sessionId}_`;
  const suffix = ".conversation.jsonl";
  let latest: string | null = null;

  for (const file of readdirSync(archiveDir)) {
    if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    if (!latest || file > latest) {
      latest = file;
    }
  }

  if (!latest) return [];
  try {
    const path = join(archiveDir, latest);
    const entries: ConversationEntry[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<ConversationEntry>;
        if (
          typeof parsed.id !== "string"
          || typeof parsed.sessionId !== "string"
          || (parsed.kind !== "user_message" && parsed.kind !== "system_message")
          || typeof parsed.text !== "string"
          || typeof parsed.createdAt !== "string"
        ) {
          continue;
        }
        entries.push(normalizeConversationEntry(parsed as ConversationEntry));
      } catch {
        // Ignore malformed lines.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Delete a session's metadata file.
 * Optionally archive it to an `archive/` subdirectory.
 */
export function deleteMetadata(dataDir: string, sessionId: SessionId, archive = true): void {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return;
  const conversation = conversationPath(dataDir, sessionId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (archive) {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${sessionId}_${timestamp}`);
    writeFileSync(archivePath, readFileSync(path, "utf-8"));
    if (existsSync(conversation)) {
      const conversationArchivePath = join(archiveDir, `${sessionId}_${timestamp}.conversation.jsonl`);
      writeFileSync(conversationArchivePath, readFileSync(conversation, "utf-8"));
    }
  }

  unlinkSync(path);
  if (existsSync(conversation)) {
    unlinkSync(conversation);
  }
}

/**
 * Read the latest archived metadata for a session.
 * Archive files are named `<sessionId>_<ISO-timestamp>` inside `<dataDir>/archive/`.
 * Returns null if no archived metadata exists.
 */
export function readArchivedMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  validateSessionId(sessionId);
  const archiveDir = join(dataDir, "archive");
  if (!existsSync(archiveDir)) return null;

  const prefix = `${sessionId}_`;
  let latest: string | null = null;

  for (const file of readdirSync(archiveDir)) {
    if (!file.startsWith(prefix)) continue;
    // Verify the separator is followed by a digit (start of ISO timestamp)
    // to avoid prefix collisions (e.g., "app" matching "app_v2_...")
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    // Pick lexicographically last (ISO timestamps sort correctly)
    if (!latest || file > latest) {
      latest = file;
    }
  }

  if (!latest) return null;
  try {
    return parseMetadataFile(readFileSync(join(archiveDir, latest), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * List all session IDs that have metadata files.
 */
export function listMetadata(dataDir: string): SessionId[] {
  if (!existsSync(dataDir)) return [];

  return readdirSync(dataDir).filter((name) => {
    if (name === "archive" || name.startsWith(".")) return false;
    if (!VALID_SESSION_ID.test(name)) return false;
    try {
      return statSync(join(dataDir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Atomically reserve a session ID by creating its metadata file with O_EXCL.
 * Returns true if the ID was successfully reserved, false if it already exists.
 */
export function reserveSessionId(dataDir: string, sessionId: SessionId): boolean {
  const path = metadataPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
