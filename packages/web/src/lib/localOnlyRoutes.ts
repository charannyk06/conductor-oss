import type { DashboardRole } from "@conductor-oss/core/types";
import { NextResponse } from "next/server";
import { getDashboardAccess, requiresPairedDeviceScope } from "@/lib/auth";
import { resolveRustBackendUrl } from "@/lib/backendUrl";
import { guardAndProxy } from "@/lib/guardedRustProxy";

type LocalOnlyOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

/** Status and code returned when a local-only route is called on a hosted dashboard. */
export const LOCAL_ONLY_STATUS = 412;
export const LOCAL_ONLY_CODE = "local_dashboard_required";

/** Whether a backend URL points at this machine. */
export function isLoopbackBackendUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127(\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function refuse(error: string): Response {
  return NextResponse.json({ error, code: LOCAL_ONLY_CODE }, { status: LOCAL_ONLY_STATUS });
}

/**
 * Proxy to the Rust backend only when this dashboard runs on the user's own
 * machine. Hosted dashboards are refused outright rather than routed through
 * a paired device, so the data these routes carry never leaves the machine.
 */
export function localOnlyProxy(
  request: Request,
  pathname: string,
  options: LocalOnlyOptions = {},
): Promise<Response> {
  return (async () => {
    const access = await getDashboardAccess(request);
    if (requiresPairedDeviceScope(access)) {
      return refuse("Saved passwords are only available in the dashboard running on your own machine.");
    }
    // A dashboard can be pointed at a backend elsewhere; a password export
    // must not follow it there.
    if (!isLoopbackBackendUrl(resolveRustBackendUrl())) {
      return refuse("Saved passwords are only available when the Conductor backend runs on this machine.");
    }
    return guardAndProxy(request, pathname, options);
  })();
}
