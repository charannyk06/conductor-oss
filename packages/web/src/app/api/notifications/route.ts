import { type NextRequest, NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { getEventBus } from "@/lib/event-bus-singleton";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications -- pending attention events for the dashboard notification center.
 *
 * Query params:
 *   - project: filter by project ID
 *   - limit: max events to return (default 20)
 *   - since: ISO date filter
 *
 * POST /api/notifications/ack -- acknowledge an event by ID.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  try {
    const eventBus = getEventBus();
    if (!eventBus) {
      return NextResponse.json({ notifications: [], metrics: null });
    }

    const searchParams = new URL(request.url).searchParams;
    const projectId = searchParams.get("project") ?? undefined;
    const limit = parseInt(searchParams.get("limit") ?? "20", 10);
    const sinceParam = searchParams.get("since");
    const since = sinceParam ? new Date(sinceParam) : undefined;

    const pending = eventBus.query({
      projectId,
      since,
      limit,
    });

    // Sort by timestamp descending (most recent first)
    const sorted = [...pending].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );

    const notifications = sorted.map((e) => ({
      id: e.id,
      type: e.type,
      priority: e.priority,
      sessionId: e.sessionId,
      projectId: e.projectId,
      message: e.message,
      timestamp: e.timestamp.toISOString(),
      data: e.data,
    }));

    return NextResponse.json({
      notifications,
      metrics: eventBus.metrics(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get notifications" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;

  try {
    const body = (await request.json()) as { action?: string; eventId?: string };
    const eventBus = getEventBus();

    if (!eventBus) {
      return NextResponse.json({ error: "Event bus not available" }, { status: 503 });
    }

    if (body.action === "ack" && body.eventId) {
      const acked = eventBus.acknowledge(body.eventId);
      return NextResponse.json({ ok: acked, eventId: body.eventId });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 500 },
    );
  }
}
