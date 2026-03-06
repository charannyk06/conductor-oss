import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isLoopbackHost } from "./lib/accessControl";
import { verifyTrustedEdgeIdentity } from "./lib/edgeAuth";
import {
  BUILTIN_REMOTE_SESSION_COOKIE,
  isBuiltinRemoteAuthEnabled,
  sanitizeRedirectTarget,
  verifyBuiltinRemoteSession,
} from "./lib/remoteAuth";

const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

export default async function proxy(
  req: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  const trustedEdgeIdentity = await verifyTrustedEdgeIdentity(req.headers, null);
  if (trustedEdgeIdentity?.ok) {
    return NextResponse.next();
  }

  if (isBuiltinRemoteAuthEnabled()) {
    const pathname = req.nextUrl.pathname;
    const isBuiltinPublicRoute =
      pathname.startsWith("/unlock") ||
      pathname.startsWith("/auth/grant") ||
      pathname.startsWith("/api/auth/session");

    if (isBuiltinPublicRoute) {
      return NextResponse.next();
    }

    const session = req.cookies.get(BUILTIN_REMOTE_SESSION_COOKIE)?.value ?? null;
    const hasValidSession = await verifyBuiltinRemoteSession(session);
    if (hasValidSession) {
      return NextResponse.next();
    }

    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error: "Access denied",
          reason: "Remote sign-in required",
        },
        { status: 403 },
      );
    }

    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/unlock";
    const nextPath = sanitizeRedirectTarget(`${pathname}${req.nextUrl.search}`);
    if (nextPath !== "/") {
      redirectUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(redirectUrl);
  }

  if (!clerkConfigured) {
    if (!isLoopbackHost(req.nextUrl.hostname)) {
      if (!req.nextUrl.pathname.startsWith("/api/")) {
        const redirectUrl = req.nextUrl.clone();
        redirectUrl.pathname = "/unlock";
        redirectUrl.searchParams.set("error", "unavailable");
        return NextResponse.redirect(redirectUrl);
      }
      return NextResponse.json(
        {
          error: "Access denied",
          reason: "Authentication is required for non-local dashboard access",
        },
        { status: 403 },
      );
    }
    return NextResponse.next();
  }

  // Dynamic import avoids crash when Clerk keys are absent.
  // clerkMiddleware() throws at call-time if publishableKey is missing.
  try {
    const { clerkMiddleware, createRouteMatcher } = await import(
      "@clerk/nextjs/server"
    );
    const isPublicRoute = createRouteMatcher(["/sign-in(.*)"]);

    const handler = clerkMiddleware(async (auth, r) => {
      if (!isPublicRoute(r)) {
        await auth.protect();
      }
    });

    return handler(req, event) as NextResponse;
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};
