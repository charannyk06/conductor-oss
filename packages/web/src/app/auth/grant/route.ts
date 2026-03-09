import { type NextRequest, NextResponse } from "next/server";
import { sanitizeRedirectTarget } from "@/lib/remoteAuth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const nextPath = sanitizeRedirectTarget(request.nextUrl.searchParams.get("next"));
  const unlockUrl = new URL("/unlock", request.url);
  if (nextPath !== "/") {
    unlockUrl.searchParams.set("next", nextPath);
  }
  unlockUrl.searchParams.set("error", "unavailable");
  return NextResponse.redirect(unlockUrl);
}
