import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { buildNormalizedChatFeed, type StoredConversationEntry } from "@/lib/chatFeed";
import { normalizeSummary } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_OUTPUT_LINES = 500;

type FeedResponse = {
  entries: ReturnType<typeof buildNormalizedChatFeed>;
  sessionStatus: string | null;
  parserState: null;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  const params = await context.params;
  const rawId = params?.id ?? "";

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId).trim();
  } catch {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  if (!VALID_SESSION_ID.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  const linesParam = request.nextUrl.searchParams.get("lines");
  const parsedLines = linesParam ? Number.parseInt(linesParam, 10) : DEFAULT_OUTPUT_LINES;
  const lines = Number.isFinite(parsedLines) && parsedLines > 0
    ? Math.min(parsedLines, 5000)
    : DEFAULT_OUTPUT_LINES;

  try {
    const { sessionManager } = await getServices();

    const [sessionResult, conversationResult, outputResult] = await Promise.allSettled([
      sessionManager.get(sessionId),
      sessionManager.getConversation(sessionId),
      sessionManager.getOutput(sessionId, lines),
    ]);

    const session = sessionResult.status === "fulfilled" ? sessionResult.value : null;
    const conversation = conversationResult.status === "fulfilled" && Array.isArray(conversationResult.value)
      ? conversationResult.value
      : [];
    const output = outputResult.status === "fulfilled" && typeof outputResult.value === "string"
      ? outputResult.value
      : null;

    if (!session && conversation.length === 0 && !output) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const entries = buildNormalizedChatFeed({
      conversation: conversation.map((entry): StoredConversationEntry => ({
        id: entry.id,
        kind: entry.kind,
        source: entry.source ?? null,
        text: entry.text,
        createdAt: entry.createdAt,
        attachments: entry.attachments ?? [],
      })),
      output,
      sessionStatus: session?.status ?? null,
      sessionSummary: normalizeSummary(session?.agentInfo?.summary ?? session?.metadata?.summary ?? null),
    });

    const payload: FeedResponse = {
      entries,
      sessionStatus: session?.status ?? null,
      parserState: null,
    };

    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load chat feed";
    const status = message.toLowerCase().includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
