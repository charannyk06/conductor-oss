import type { DashboardRole } from "@conductor-oss/core/types";
import { NextResponse } from "next/server";
import { getDashboardAccess, requiresPairedDeviceScope } from "@/lib/auth";
import {
  guardAndProxyEventStreamToBridgeDevice,
  getBridgeIdFromRequest,
  guardAndProxyToBridgeDevice,
} from "@/lib/bridgeApiProxy";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";
import { guardAndProxy, guardAndProxyEventStream } from "@/lib/guardedRustProxy";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";

type GuardOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
  bridgeAware?: boolean;
  responseMapper?: (payload: unknown, bridgeId: string) => unknown;
};

type RouteParams = Record<string, string | undefined>;
type RouteContext = { params: Promise<RouteParams> };

async function rejectHostedLocalFallback(request: Request): Promise<Response | null> {
  const access = await getDashboardAccess(request);
  if (!access.ok || !requiresPairedDeviceScope(access)) {
    return null;
  }

  return NextResponse.json(
    {
      error: "Paired device required",
      reason: "Hosted dashboard workspaces and sessions must target a connected laptop.",
    },
    { status: 412 },
  );
}

export function guardedProxyRoute(pathname: string, options: GuardOptions = {}) {
  return async function proxyRoute(request: Request): Promise<Response> {
    if (options.bridgeAware) {
      const bridgeId = getBridgeIdFromRequest(request);
      if (bridgeId) {
        return guardAndProxyToBridgeDevice(request, bridgeId, pathname, options);
      }

      const rejected = await rejectHostedLocalFallback(request);
      if (rejected) {
        return rejected;
      }
    }
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
    if (options.bridgeAware) {
      const bridgeId = getBridgeIdFromRequest(request);
      if (bridgeId) {
        return guardAndProxyToBridgeDevice(request, bridgeId, buildPathname(params), options);
      }

      const rejected = await rejectHostedLocalFallback(request);
      if (rejected) {
        return rejected;
      }
    }
    return guardAndProxy(request, buildPathname(params), options);
  };
}

export function guardedEventStreamParamRoute(
  buildPathname: (params: RouteParams) => string,
  options: GuardOptions = {},
) {
  return async function proxyEventStreamParamRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    if (options.bridgeAware) {
      const bridgeId = getBridgeIdFromRequest(request);
      if (bridgeId) {
        return guardAndProxyEventStreamToBridgeDevice(
          request,
          bridgeId,
          buildPathname(params),
          options,
        );
      }

      const rejected = await rejectHostedLocalFallback(request);
      if (rejected) {
        return rejected;
      }
    }
    return guardAndProxyEventStream(request, buildPathname(params), options);
  };
}

export function guardedSessionProxyParamRoute(
  buildPathname: (params: RouteParams) => string,
  options: GuardOptions = {},
) {
  return async function proxySessionParamRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const bridgeSession = decodeBridgeSessionId(params.id);
    if (bridgeSession) {
      return guardAndProxyToBridgeDevice(
        request,
        bridgeSession.bridgeId,
        buildPathname({ ...params, id: bridgeSession.sessionId }),
        options,
      );
    }

    const bridgeId = getBridgeIdFromRequest(request);
    if (bridgeId) {
      return guardAndProxyToBridgeDevice(
        request,
        bridgeId,
        buildPathname(params),
        options,
      );
    }

    const rejected = await rejectHostedLocalFallback(request);
    if (rejected) {
      return rejected;
    }

    return guardAndProxy(request, buildPathname(params), options);
  };
}

export function guardedSessionEventStreamParamRoute(
  buildPathname: (params: RouteParams) => string,
  options: GuardOptions = {},
) {
  return async function proxySessionEventStreamParamRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const bridgeSession = decodeBridgeSessionId(params.id);
    if (bridgeSession) {
      return guardAndProxyEventStreamToBridgeDevice(
        request,
        bridgeSession.bridgeId,
        buildPathname({ ...params, id: bridgeSession.sessionId }),
        options,
      );
    }

    const bridgeId = getBridgeIdFromRequest(request);
    if (bridgeId) {
      return guardAndProxyEventStreamToBridgeDevice(
        request,
        bridgeId,
        buildPathname(params),
        options,
      );
    }

    const rejected = await rejectHostedLocalFallback(request);
    if (rejected) {
      return rejected;
    }

    return guardAndProxyEventStream(request, buildPathname(params), options);
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
