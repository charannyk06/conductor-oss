import { NextResponse, type NextRequest } from "next/server";
import { buildNormalizedChatFeed, type NormalizedChatEntry, type StoredConversationEntry } from "@/lib/chatFeed";
import { getServices } from "@/lib/services";

const REMOTE_EXECUTOR_URL = process.env["CONDUCTOR_EXECUTOR_URL"]?.trim() || "";
const REMOTE_EXECUTOR_TOKEN = process.env["CONDUCTOR_EXECUTOR_REMOTE_TOKEN"]?.trim() || "";
const INTERNAL_EXECUTOR_TOKEN = process.env["CONDUCTOR_EXECUTOR_INTERNAL_TOKEN"]?.trim() || "";
const INTERNAL_TOKEN_HEADER = "x-conductor-executor-internal-token";
const REMOTE_TOKEN_HEADER = "x-conductor-executor-token";

export interface ExecutorSessionFeedResponse {
  entries: NormalizedChatEntry[];
  sessionStatus: string | null;
  source: string;
}

export interface ExecutorSendRequest {
  message: string;
  attachments?: string[];
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface ExecutorHealthResponse {
  status: "ok" | "degraded";
  mode: "local" | "remote" | "remote-fallback";
  transport: string;
  remoteUrl?: string | null;
  capabilities: string[];
}

export interface ExecutionBackend {
  getFeed(sessionId: string, lines?: number): Promise<ExecutorSessionFeedResponse>;
  send(sessionId: string, payload: ExecutorSendRequest): Promise<void>;
  health(): Promise<ExecutorHealthResponse>;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeAttachments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item): item is string => Boolean(item));
}

function toStoredConversationEntries(value: unknown): StoredConversationEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is StoredConversationEntry => Boolean(entry) && typeof entry === "object");
}

async function buildLocalFeed(sessionId: string, lines = 1200): Promise<ExecutorSessionFeedResponse> {
  const { sessionManager } = await getServices();

  const [session, conversation, output] = await Promise.all([
    sessionManager.get(sessionId).catch(() => null),
    sessionManager.getConversation(sessionId).catch(() => []),
    sessionManager.getOutput(sessionId, lines).catch(() => null),
  ]);

  const sessionRecord = session as Record<string, unknown> | null;
  const metadata = (sessionRecord?.metadata && typeof sessionRecord.metadata === "object")
    ? sessionRecord.metadata as Record<string, unknown>
    : null;

  return {
    entries: buildNormalizedChatFeed({
      conversation: toStoredConversationEntries(conversation),
      output: safeString(output),
      sessionStatus: safeString(sessionRecord?.status),
      sessionSummary: safeString(sessionRecord?.summary) ?? safeString(metadata?.summary),
    }),
    sessionStatus: safeString(sessionRecord?.status),
    source: output ? "local-runtime" : "local-conversation-only",
  };
}

async function sendLocal(sessionId: string, payload: ExecutorSendRequest): Promise<void> {
  const trimmedMessage = payload.message.trim();
  const attachments = normalizeAttachments(payload.attachments);

  if (!trimmedMessage && attachments.length === 0) {
    throw new Error("Message or attachments are required");
  }

  const { sessionManager } = await getServices();
  await sessionManager.send(sessionId, trimmedMessage, {
    attachments,
    model: safeString(payload.model),
    reasoningEffort: safeString(payload.reasoningEffort),
  });
}

function internalHeaders(): HeadersInit {
  if (!INTERNAL_EXECUTOR_TOKEN) return {};
  return { [INTERNAL_TOKEN_HEADER]: INTERNAL_EXECUTOR_TOKEN };
}

function remoteHeaders(): HeadersInit {
  if (!REMOTE_EXECUTOR_TOKEN) return {};
  return { [REMOTE_TOKEN_HEADER]: REMOTE_EXECUTOR_TOKEN };
}

async function remoteGet<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, `${REMOTE_EXECUTOR_URL}/`).toString(), {
    cache: "no-store",
    headers: remoteHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Executor request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function remoteSend(path: string, payload: ExecutorSendRequest): Promise<void> {
  const response = await fetch(new URL(path, `${REMOTE_EXECUTOR_URL}/`).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...remoteHeaders(),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `Executor request failed: ${response.status}`);
  }
}

function createLocalExecutionBackend(): ExecutionBackend {
  return {
    getFeed: (sessionId, lines) => buildLocalFeed(sessionId, lines),
    send: (sessionId, payload) => sendLocal(sessionId, payload),
    health: async () => ({
      status: "ok",
      mode: "local",
      transport: "session-manager",
      remoteUrl: null,
      capabilities: ["feed", "send"],
    }),
  } satisfies ExecutionBackend;
}

function createRemoteExecutionBackend(): ExecutionBackend {
  const local = createLocalExecutionBackend();

  return {
    async getFeed(sessionId, lines = 1200) {
      try {
        const query = new URLSearchParams({ lines: String(lines) });
        return await remoteGet<ExecutorSessionFeedResponse>(`/sessions/${encodeURIComponent(sessionId)}/feed?${query.toString()}`);
      } catch {
        const fallback = await local.getFeed(sessionId, lines);
        return { ...fallback, source: "remote-fallback-feed" };
      }
    },
    async send(sessionId, payload) {
      try {
        await remoteSend(`/sessions/${encodeURIComponent(sessionId)}/send`, payload);
      } catch {
        await local.send(sessionId, payload);
      }
    },
    async health() {
      try {
        const response = await remoteGet<ExecutorHealthResponse>("/health");
        return { ...response, mode: "remote", remoteUrl: REMOTE_EXECUTOR_URL };
      } catch {
        return {
          status: "degraded",
          mode: "remote-fallback",
          transport: "session-manager",
          remoteUrl: REMOTE_EXECUTOR_URL,
          capabilities: ["feed", "send"],
        };
      }
    },
  } satisfies ExecutionBackend;
}

export function getExecutionBackend(): ExecutionBackend {
  return REMOTE_EXECUTOR_URL ? createRemoteExecutionBackend() : createLocalExecutionBackend();
}

export async function getLocalExecutionFeed(sessionId: string, lines = 1200): Promise<ExecutorSessionFeedResponse> {
  return buildLocalFeed(sessionId, lines);
}

export async function sendLocalExecutionMessage(sessionId: string, payload: ExecutorSendRequest): Promise<void> {
  return sendLocal(sessionId, payload);
}

export function authorizeInternalExecutorRequest(request: NextRequest): NextResponse | null {
  if (!INTERNAL_EXECUTOR_TOKEN) {
    return NextResponse.json({ error: "Internal executor token is not configured" }, { status: 503 });
  }
  const provided = request.headers.get(INTERNAL_TOKEN_HEADER)?.trim() || "";
  if (provided && provided === INTERNAL_EXECUTOR_TOKEN) {
    return null;
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function getInternalExecutorHeaders(): HeadersInit {
  return internalHeaders();
}
