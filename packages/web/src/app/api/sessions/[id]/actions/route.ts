import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/sessions/[id]/actions -- one-tap session actions for mobile UX.
 *
 * Body: { action: "retry" | "kill" | "send", message?: string }
 *
 * Consolidates multiple endpoints into a single mobile-friendly action router.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;

  const { id } = await params;

  try {
    const body = (await request.json()) as { action?: string; message?: string };
    const action = body.action;

    if (!action) {
      return NextResponse.json({ error: "Missing 'action' field" }, { status: 400 });
    }

    const { sessionManager } = await getServices();

    switch (action) {
      case "retry":
      case "restore": {
        const session = await sessionManager.restore(id);
        return NextResponse.json({
          ok: true,
          action: "restore",
          sessionId: id,
          status: session?.status ?? "restored",
        });
      }

      case "kill":
      case "terminate": {
        await sessionManager.kill(id);
        return NextResponse.json({
          ok: true,
          action: "kill",
          sessionId: id,
        });
      }

      case "send": {
        const message = body.message;
        if (!message) {
          return NextResponse.json({ error: "Missing 'message' for send action" }, { status: 400 });
        }
        await sessionManager.send(id, message);
        return NextResponse.json({
          ok: true,
          action: "send",
          sessionId: id,
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid: retry, kill, send` },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 500 },
    );
  }
}
