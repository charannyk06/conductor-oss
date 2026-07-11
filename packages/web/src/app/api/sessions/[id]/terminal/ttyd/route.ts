import { NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";
import {
  buildPatchedTtydHtmlResponse,
  injectTtydResizeShim,
  resolveBridgeSessionTarget,
} from "@/lib/bridgeTtyd";
import { readTtydHtmlResponse } from "@/lib/ttydHtmlResponse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};


/**
 * Inject the resize coordination shim into a proxied HTML response.
 * Falls back to the original response if the content is not HTML.
 */
async function injectResizeShimIntoResponse(proxied: Response): Promise<Response> {
  const html = await readTtydHtmlResponse(proxied);
  if (html === null) {
    return proxied;
  }

  return buildPatchedTtydHtmlResponse(proxied, injectTtydResizeShim(html));
}

function redirectToFirstPartyTerminal(
  request: Request,
  routeSessionId: string,
  bridgeId: string,
): Response {
  const target = new URL(
    `/embed/terminal/${encodeURIComponent(routeSessionId)}`,
    request.url,
  );
  target.searchParams.set("bridgeId", bridgeId);
  return NextResponse.redirect(target, { status: 307 });
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const target = resolveBridgeSessionTarget(id, request);
  if (!target) {
    // Non-bridge session: proxy to Rust backend, then inject resize shim into HTML.
    const denied = await guardApiAccess(request, "operator");
    if (denied) {
      return denied;
    }

    const proxied = await proxyToRustOrUnavailable(
      request,
      `/api/sessions/${encodeURIComponent(id ?? "")}/terminal/ttyd`,
      {
        headers: await buildForwardedAccessHeaders(request),
      },
    );

    return injectResizeShimIntoResponse(proxied);
  }

  // Never execute paired-device HTML in the dashboard origin. The first-party
  // embed speaks the same relay terminal protocol without trusting upstream DOM.
  const denied = await guardApiAccess(request, "operator");
  if (denied) {
    return denied;
  }
  return redirectToFirstPartyTerminal(request, id, target.bridgeId);
}
