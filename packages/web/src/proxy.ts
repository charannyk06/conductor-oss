import { NextResponse, type NextRequest } from "next/server";

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
): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;
  const shouldRewrite = shouldProxyToRust(pathname);
  return shouldRewrite ? rewriteToBackend(req) : NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico)).*)",
  ],
};
