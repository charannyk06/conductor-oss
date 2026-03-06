import { type NextRequest, NextResponse } from "next/server";
import {
  BUILTIN_REMOTE_SESSION_COOKIE,
  createBuiltinRemoteSessionValue,
  getBuiltinRemoteSessionCookieOptions,
  isBuiltinRemoteAuthEnabled,
  isValidBuiltinAccessToken,
  sanitizeRedirectTarget,
} from "@/lib/remoteAuth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const nextPath = sanitizeRedirectTarget(request.nextUrl.searchParams.get("next"));
  const unlockUrl = new URL("/unlock", request.url);
  if (nextPath !== "/") {
    unlockUrl.searchParams.set("next", nextPath);
  }

  if (!isBuiltinRemoteAuthEnabled()) {
    unlockUrl.searchParams.set("error", "unavailable");
    return NextResponse.redirect(unlockUrl);
  }

  const token = request.nextUrl.searchParams.get("token");
  if (!isValidBuiltinAccessToken(token)) {
    unlockUrl.searchParams.set("error", "invalid");
    return NextResponse.redirect(unlockUrl);
  }

  const redirectUrl = new URL(nextPath, request.url);
  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set(
    BUILTIN_REMOTE_SESSION_COOKIE,
    await createBuiltinRemoteSessionValue(),
    getBuiltinRemoteSessionCookieOptions(request.nextUrl.protocol === "https:"),
  );
  return response;
}
