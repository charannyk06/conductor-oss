import type { DashboardRole } from "@conductor-oss/core/types";
import { NextResponse } from "next/server";
import { getDashboardAccess, requiresPairedDeviceScope } from "@/lib/auth";
import { guardAndProxy } from "@/lib/guardedRustProxy";

type LocalOnlyOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

/** Status and code returned when a local-only route is called on a hosted dashboard. */
export const LOCAL_ONLY_STATUS = 412;
export const LOCAL_ONLY_CODE = "local_dashboard_required";

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
      return NextResponse.json(
        {
          error: "Saved passwords are only available in the dashboard running on your own machine.",
          code: LOCAL_ONLY_CODE,
        },
        { status: LOCAL_ONLY_STATUS },
      );
    }
    return guardAndProxy(request, pathname, options);
  })();
}
