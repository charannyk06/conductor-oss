import { type NextRequest, NextResponse } from "next/server";
import {
  BUILTIN_REMOTE_SESSION_COOKIE,
  createBuiltinRemoteSessionValue,
  getBuiltinRemoteSessionCookieOptions,
  isBuiltinRemoteAuthEnabled,
  isValidBuiltinAccessToken,
} from "@/lib/remoteAuth";

type SessionRequestBody = {
  token?: unknown;
};

function clearSession(response: NextResponse): void {
  response.cookies.set(BUILTIN_REMOTE_SESSION_COOKIE, "", {
    ...getBuiltinRemoteSessionCookieOptions(false),
    maxAge: 0,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isBuiltinRemoteAuthEnabled()) {
    return NextResponse.json({ error: "Built-in remote auth is not enabled" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as SessionRequestBody | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!isValidBuiltinAccessToken(token)) {
    return NextResponse.json({ error: "Invalid access token" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    BUILTIN_REMOTE_SESSION_COOKIE,
    await createBuiltinRemoteSessionValue(),
    getBuiltinRemoteSessionCookieOptions(request.nextUrl.protocol === "https:"),
  );
  return response;
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  clearSession(response);

  if (!isBuiltinRemoteAuthEnabled()) {
    return response;
  }

  response.cookies.set(BUILTIN_REMOTE_SESSION_COOKIE, "", {
    ...getBuiltinRemoteSessionCookieOptions(request.nextUrl.protocol === "https:"),
    maxAge: 0,
  });
  return response;
}
