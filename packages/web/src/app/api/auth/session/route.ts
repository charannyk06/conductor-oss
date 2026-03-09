import { type NextRequest, NextResponse } from "next/server";
import { guardApiActionAccess } from "@/lib/auth";
import {
  BUILTIN_REMOTE_SESSION_COOKIE,
  getBuiltinRemoteSessionCookieOptions,
} from "@/lib/remoteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "https") return true;
  if (forwardedProto === "http") return false;
  return request.nextUrl.protocol === "https:";
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = guardApiActionAccess(request);
  if (denied) return denied;
  return NextResponse.json(
    { error: "Public share-link remote access has been removed. Use the private Tailscale link or a protected enterprise URL instead." },
    { status: 410 },
  );
}

export function DELETE(request: NextRequest): Response {
  const denied = guardApiActionAccess(request);
  if (denied) return denied;

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    BUILTIN_REMOTE_SESSION_COOKIE,
    "",
    {
      ...getBuiltinRemoteSessionCookieOptions(isSecureRequest(request)),
      maxAge: 0,
    },
  );
  return response;
}
