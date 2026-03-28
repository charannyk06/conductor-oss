import type { DashboardRole } from "@conductor-oss/core/types";
import { NextRequest } from "next/server";
import type { DashboardAccess } from "@/lib/auth";
import { getDashboardAccess, guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";

type ProxyOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

const PROXY_AUTHORIZED_HEADER = "x-conductor-proxy-authorized";
const PROXY_AUTHENTICATED_HEADER = "x-conductor-access-authenticated";
const PROXY_ROLE_HEADER = "x-conductor-access-role";
const PROXY_EMAIL_HEADER = "x-conductor-access-email";
const PROXY_PROVIDER_HEADER = "x-conductor-access-provider";
const PROXY_SECRET_HEADER = "x-conductor-proxy-secret";

function proxyAuthSecret(): string | null {
  const secret = process.env.CONDUCTOR_PROXY_AUTH_SECRET?.trim();
  return secret ? secret : null;
}

export function forwardedAccessAuthenticated(access: DashboardAccess): boolean {
  return access.authenticated || access.provider === "local";
}

export async function buildForwardedAccessHeaders(request: Request): Promise<Headers> {
  const access = await getDashboardAccess(request);
  const headers = new Headers({
    [PROXY_AUTHORIZED_HEADER]: "true",
    [PROXY_AUTHENTICATED_HEADER]: forwardedAccessAuthenticated(access) ? "true" : "false",
  });

  if (access.role) {
    headers.set(PROXY_ROLE_HEADER, access.role);
  }
  if (access.email) {
    headers.set(PROXY_EMAIL_HEADER, access.email);
  }
  if (access.provider) {
    headers.set(PROXY_PROVIDER_HEADER, access.provider);
  }
  const sharedSecret = proxyAuthSecret();
  if (sharedSecret) {
    // Shared secret prevents forged proxy auth headers when the Rust backend is exposed off-host.
    headers.set(PROXY_SECRET_HEADER, sharedSecret);
  }

  return headers;
}

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

  return proxyToRustOrUnavailable(request, pathname, {
    headers: await buildForwardedAccessHeaders(request),
  });
}
