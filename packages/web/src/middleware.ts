import { NextResponse, type NextRequest } from "next/server";

const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

export default async function middleware(
  req: NextRequest,
): Promise<NextResponse> {
  if (!clerkConfigured) {
    return NextResponse.next();
  }

  // Dynamic import avoids crash when Clerk keys are absent —
  // clerkMiddleware() throws at call-time if publishableKey is missing.
  const { clerkMiddleware, createRouteMatcher } = await import(
    "@clerk/nextjs/server"
  );
  const isPublicRoute = createRouteMatcher(["/sign-in(.*)"]);

  const handler = clerkMiddleware(async (auth, r) => {
    if (!isPublicRoute(r)) {
      await auth.protect();
    }
  });

  return handler(req, {} as never) as unknown as NextResponse;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};
