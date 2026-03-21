import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|__clerk|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
};
