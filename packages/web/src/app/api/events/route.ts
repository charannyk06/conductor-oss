import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/events -- SSE stream for real-time session updates.
 *
 * Polls SessionManager.list() every 5 seconds, sends compact snapshots.
 * Heartbeat every 15 seconds to keep the connection alive.
 *
 * Fixes applied:
 *   - Respects request.signal for abort handling (prevents interval leaks)
 *   - inFlight guard prevents overlapping poll promises
 *   - Closed flag prevents enqueue-after-close errors
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let inFlight = false;

  function cleanup(): void {
    closed = true;
    clearInterval(heartbeat);
    clearInterval(updates);
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

  function buildSnapshotPayload(sessions: ReturnType<typeof sessionToDashboard>[]): string {
    const event = {
      type: "snapshot",
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        activity: s.activity,
        attentionLevel: getAttentionLevel(s),
        lastActivityAt: s.lastActivityAt,
        summary: s.summary,
        pr: s.pr ? {
          ciStatus: s.pr.ciStatus,
          reviewDecision: s.pr.reviewDecision,
          state: s.pr.state,
          mergeable: s.pr.mergeability.mergeable,
        } : null,
      })),
    };
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  const stream = new ReadableStream({
    start(controller) {
      // Abort when client disconnects
      request.signal.addEventListener("abort", () => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });

      // Send initial snapshot
      void (async () => {
        try {
          const { sessionManager } = await getServices();
          const sessions = await sessionManager.list();
          const dashboardSessions = sessions.map(sessionToDashboard);
          safeSend(controller, buildSnapshotPayload(dashboardSessions));
        } catch {
          safeSend(controller, `data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`);
        }
      })();

      // Heartbeat every 15s
      heartbeat = setInterval(() => {
        if (!safeSend(controller, `: heartbeat\n\n`)) {
          cleanup();
        }
      }, 15_000);

      // Poll for state changes every 5s (with inFlight guard)
      updates = setInterval(() => {
        if (closed || inFlight) return;
        inFlight = true;
        void (async () => {
          try {
            const { sessionManager } = await getServices();
            const sessions = await sessionManager.list();
            const dashboardSessions = sessions.map(sessionToDashboard);
            safeSend(controller, buildSnapshotPayload(dashboardSessions));
          } catch {
            // Skip this poll, retry next interval
          } finally {
            inFlight = false;
          }
        })();
      }, 3_000);
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
