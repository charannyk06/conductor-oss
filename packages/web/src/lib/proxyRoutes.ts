import type { DashboardRole } from "@conductor-oss/core/types";
import { guardAndProxy } from "@/lib/guardedRustProxy";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";

type GuardOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

type RouteParams = Record<string, string | undefined>;
type RouteContext = { params: Promise<RouteParams> };

export function guardedProxyRoute(pathname: string, options: GuardOptions = {}) {
  return async function proxyRoute(request: Request): Promise<Response> {
    return guardAndProxy(request, pathname, options);
  };
}

export function guardedProxyParamRoute(
  buildPathname: (params: RouteParams) => string,
  options: GuardOptions = {},
) {
  return async function proxyParamRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    return guardAndProxy(request, buildPathname(params), options);
  };
}

export function openProxyRoute(pathname: string) {
  return async function proxyRoute(request: Request): Promise<Response> {
    return proxyToRustOrUnavailable(request, pathname);
  };
}

export function openProxyParamRoute(buildPathname: (params: RouteParams) => string) {
  return async function proxyParamRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    return proxyToRustOrUnavailable(request, buildPathname(params));
  };
}
