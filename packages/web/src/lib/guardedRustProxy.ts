import type { DashboardRole } from "@conductor-oss/core/types";
import { NextRequest } from "next/server";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";

type ProxyOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

export async function guardAndProxy(
  request: Request,
  pathname: string,
  options: ProxyOptions = {},
): Promise<Response> {
  const denied = await guardApiAccess(request, options.role ?? "viewer");
  if (denied) return denied;

  if (options.requireActionGuard) {
    const deniedAction = guardApiActionAccess(request as NextRequest);
    if (deniedAction) return deniedAction;
  }

  return proxyToRustOrUnavailable(request, pathname);
}
