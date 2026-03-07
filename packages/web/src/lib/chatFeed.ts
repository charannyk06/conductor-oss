export type NormalizedChatEntryKind = "assistant" | "status" | "system" | "user";

export interface StoredConversationEntry {
  id?: string | null;
  kind?: string | null;
  source?: string | null;
  text?: string | null;
  createdAt?: string | null;
  attachments?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface NormalizedChatEntry {
  id: string;
  kind: NormalizedChatEntryKind;
  label: string;
  text: string;
  createdAt: string | null;
  attachments: string[];
  source: string | null;
  streaming: boolean;
  metadata: Record<string, unknown>;
}

export interface BuildNormalizedChatFeedInput {
  conversation: StoredConversationEntry[];
  output?: string | null;
  sessionStatus?: string | null;
  sessionSummary?: string | null;
}

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeText(value: string): string {
  return value
    .replace(OSC_PATTERN, "")
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function makeStableId(prefix: string, value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return `${prefix}-${Math.abs(hash)}`;
}

function normalizeAttachments(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
}

function toEntryLabel(kind: string | null | undefined, source: string | null | undefined): string {
  if (kind === "user_message") {
    return source === "feedback" ? "Feedback" : "You";
  }
  if (kind === "system_message") {
    return source === "restore" ? "Restored" : "System";
  }
  return "Session";
}

function toEntryKind(kind: string | null | undefined): NormalizedChatEntryKind {
  if (kind === "user_message") return "user";
  if (kind === "system_message") return "system";
  return "status";
}

function stripLeadingPromptEcho(output: string, conversation: StoredConversationEntry[]): string {
  const lastUserText = [...conversation]
    .reverse()
    .find((entry) => entry.kind === "user_message" && typeof entry.text === "string")
    ?.text
    ?.trim();

  if (!lastUserText) return output;

  const normalizedPrompt = normalizeText(lastUserText);
  if (!normalizedPrompt) return output;

  if (output.startsWith(normalizedPrompt)) {
    return output.slice(normalizedPrompt.length).trim();
  }

  const compactPrompt = normalizedPrompt.replace(/\s+/g, " ");
  const compactOutput = output.replace(/\s+/g, " ");
  if (compactOutput.startsWith(compactPrompt)) {
    return output.slice(Math.min(normalizedPrompt.length, output.length)).trim();
  }

  return output;
}

function createAssistantEntry(
  output: string,
  sessionStatus: string | null | undefined,
): NormalizedChatEntry | null {
  const normalizedOutput = normalizeText(output);
  if (!normalizedOutput) return null;

  return {
    id: makeStableId("assistant", normalizedOutput),
    kind: "assistant",
    label: sessionStatus === "running" ? "Assistant live output" : "Assistant",
    text: normalizedOutput,
    createdAt: null,
    attachments: [],
    source: "runtime-output",
    streaming: sessionStatus === "running",
    metadata: {},
  };
}

function createStatusEntry(status: string | null | undefined, summary: string | null | undefined): NormalizedChatEntry | null {
  const normalizedStatus = status?.trim();
  const normalizedSummary = summary?.trim();
  if (!normalizedStatus && !normalizedSummary) return null;

  const parts = [
    normalizedSummary,
    normalizedStatus ? `Session status: ${normalizedStatus}` : null,
  ].filter((value): value is string => Boolean(value));

  const text = parts.join("\n\n").trim();
  if (!text) return null;

  return {
    id: makeStableId("status", text),
    kind: "status",
    label: "Session",
    text,
    createdAt: null,
    attachments: [],
    source: "session-status",
    streaming: normalizedStatus === "running",
    metadata: normalizedStatus ? { status: normalizedStatus } : {},
  };
}

export function buildNormalizedChatFeed({
  conversation,
  output,
  sessionStatus,
  sessionSummary,
}: BuildNormalizedChatFeedInput): NormalizedChatEntry[] {
  const feed: NormalizedChatEntry[] = conversation
    .filter((entry) => typeof entry?.text === "string" && entry.text.trim().length > 0)
    .map((entry) => {
      const normalizedText = normalizeText(entry.text ?? "");
      const stableKey = entry.id?.trim() || `${entry.kind ?? "entry"}:${entry.createdAt ?? normalizedText}`;
      return {
        id: makeStableId("entry", stableKey),
        kind: toEntryKind(entry.kind),
        label: toEntryLabel(entry.kind, entry.source),
        text: normalizedText,
        createdAt: entry.createdAt?.trim() || null,
        attachments: normalizeAttachments(entry.attachments),
        source: entry.source?.trim() || null,
        streaming: false,
        metadata: entry.metadata ?? {},
      } satisfies NormalizedChatEntry;
    });

  const statusEntry = createStatusEntry(sessionStatus, sessionSummary);
  if (statusEntry) {
    const duplicateStatus = feed.some((entry) => entry.kind === "status" && entry.text === statusEntry.text);
    if (!duplicateStatus) {
      feed.unshift(statusEntry);
    }
  }

  const assistantEntry = output ? createAssistantEntry(stripLeadingPromptEcho(output, conversation), sessionStatus) : null;
  if (assistantEntry) {
    const duplicateAssistant = feed.some((entry) => entry.kind === "assistant" && entry.text === assistantEntry.text);
    if (!duplicateAssistant) {
      feed.push(assistantEntry);
    }
  }

  return feed;
}
