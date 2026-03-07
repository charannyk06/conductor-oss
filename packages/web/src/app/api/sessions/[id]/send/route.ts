import { type NextRequest, NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { getExecutionBackend, type ExecutorSendRequest } from "@/lib/executionBackend";

export const dynamic = "force-dynamic";

function normalizePayload(value: unknown): ExecutorSendRequest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    message: typeof record.message === "string" ? record.message : "",
    attachments: Array.isArray(record.attachments)
      ? record.attachments.filter((item): item is string => typeof item === "string")
      : [],
    model: typeof record.model === "string" ? record.model : null,
    reasoningEffort: typeof record.reasoningEffort === "string" ? record.reasoningEffort : null,
  };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(undefined, "operator");
  if (denied) return denied;

  const params = await context.params;
  const rawId = params?.id ?? "";

  let sessionId = "";
  try {
    sessionId = decodeURIComponent(rawId).trim();
  } catch {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  try {
    const payload = normalizePayload(await request.json());
    await getExecutionBackend().send(sessionId, payload);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message";
    const lowered = message.toLowerCase();
    const status = lowered.includes("required") ? 400 : lowered.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
