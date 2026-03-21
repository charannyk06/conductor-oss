import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

function hasClerkServerKeys(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()
    && process.env.CLERK_SECRET_KEY?.trim(),
  );
}

const clerkHandler = hasClerkServerKeys() ? clerkMiddleware() : null;

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (!clerkHandler) {
    return NextResponse.next();
  }

  return clerkHandler(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|__clerk|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
};
