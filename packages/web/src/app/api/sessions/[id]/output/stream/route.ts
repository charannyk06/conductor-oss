import type { NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

function parseLines(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 500;
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return Math.min(parsed, 5000);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const params = await context.params;
  const rawId = params?.id ?? "";
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId).trim();
  } catch {
    return new Response("Invalid session id", { status: 400 });
  }
  if (!sessionId) return new Response("Session id is required", { status: 400 });

  const lines = parseLines(new URL(request.url).searchParams.get("lines"));

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let closed = false;
  let lastOutput = "";

  function cleanup(): void {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (updates) clearInterval(updates);
  }

  function safeSend(controller: ReadableStreamDefaultController, chunk: string): boolean {
    if (closed) return false;
    try {
      controller.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      cleanup();
      return false;
    }
  }

  async function sendOutput(
    controller: ReadableStreamDefaultController,
    force = false,
  ): Promise<void> {
    try {
      const { sessionManager } = await getServices();
      const output = await sessionManager.getOutput(sessionId, lines);
      if (force || output !== lastOutput) {
        lastOutput = output;
        safeSend(controller, `data: ${JSON.stringify({ type: "output", output })}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stream output";
      safeSend(controller, `data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Ignore already-closed stream errors.
        }
      });

      void sendOutput(controller, true);

      heartbeat = setInterval(() => {
        if (!safeSend(controller, ": heartbeat\n\n")) cleanup();
      }, 15_000);

      updates = setInterval(() => {
        if (closed || inFlight) return;
        inFlight = true;
        void sendOutput(controller).finally(() => {
          inFlight = false;
        });
      }, 1000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
