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

const backendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim() || "";
// Sensitive browser API requests should terminate in Next so the route-level auth,
// role checks, and CSRF/origin guards are consistently enforced.
const RUST_API_PREFIXES: string[] = [];

function shouldProxyToRust(pathname: string): boolean {
  return backendUrl.length > 0 && RUST_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function rewriteToBackend(req: NextRequest): NextResponse {
  const target = new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, backendUrl);
  return NextResponse.rewrite(target);
}

export default async function proxy(
  req: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;
  const shouldRewrite = shouldProxyToRust(pathname);
  const trustedEdgeIdentity = await verifyTrustedEdgeIdentity(req.headers, null);
  if (trustedEdgeIdentity?.ok) {
    return shouldRewrite ? rewriteToBackend(req) : NextResponse.next();
  }

  if (isBuiltinRemoteAuthEnabled()) {
    const isBuiltinPublicRoute =
      pathname.startsWith("/unlock") ||
      pathname.startsWith("/auth/grant") ||
      pathname.startsWith("/api/auth/session");

    if (isBuiltinPublicRoute) {
      return shouldRewrite ? rewriteToBackend(req) : NextResponse.next();
    }

    const session = req.cookies.get(BUILTIN_REMOTE_SESSION_COOKIE)?.value ?? null;
    const hasValidSession = await verifyBuiltinRemoteSession(session);
    if (hasValidSession) {
      return shouldRewrite ? rewriteToBackend(req) : NextResponse.next();
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
      if (!pathname.startsWith("/api/")) {
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
    return shouldRewrite ? rewriteToBackend(req) : NextResponse.next();
  }

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

    const response = handler(req, event) as NextResponse;
    if (shouldRewrite) {
      return rewriteToBackend(req);
    }
    return response;
  } catch {
    // Fail closed: if Clerk middleware throws, deny access instead of allowing through.
    return NextResponse.json(
      { error: "Authentication service unavailable" },
      { status: 503 },
    );
  }
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};
