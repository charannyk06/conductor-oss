import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

export default async function middleware(
  req: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  if (!clerkConfigured) {
    return NextResponse.next();
  }

  // Dynamic import avoids crash when Clerk keys are absent —
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
