import type { DashboardAccessConfig, DashboardRole } from "@conductor-oss/core/types";
import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { resolveRoleForEmail, roleMeetsRequirement, isLoopbackHost } from "@/lib/accessControl";
import { verifyTrustedEdgeIdentity } from "@/lib/edgeAuth";
import { BUILTIN_REMOTE_SESSION_COOKIE, isBuiltinRemoteAuthEnabled, verifyBuiltinRemoteSession } from "@/lib/remoteAuth";
import { getServices } from "@/lib/services";

const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

type DashboardIdentityProvider =
  | "local"
  | "builtin"
  | "clerk"
  | "trusted-header"
  | "cloudflare-access";

export interface DashboardAccess {
  ok: boolean;
  authenticated: boolean;
  role?: DashboardRole;
  email?: string;
  provider?: DashboardIdentityProvider;
  reason?: string;
}

function parseCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

type HostParts = {
  hostname: string;
  port: string;
  host: string;
};

type ClerkUser = {
  emailAddresses: { id: string; emailAddress: string }[];
  primaryEmailAddressId: string | null;
  publicMetadata: Record<string, unknown>;
};

function parseHostParts(value: string, fallbackHost?: string): HostParts | null {
  try {
    const url = new URL(value, fallbackHost ? `https://${fallbackHost}` : undefined);
    const hostname = url.hostname.toLowerCase();
    const port = url.port || "443";
    return { hostname, port, host: `${hostname}:${port}` };
  } catch {
    return null;
  }
}

function equivalentHost(candidate: string, expectedHost: string): boolean {
  if (candidate.toLowerCase() === expectedHost.toLowerCase()) return true;

  const expected = parseHostParts(`https://${expectedHost}`);
  const current = parseHostParts(`https://${candidate}`);
  if (!expected || !current) return false;

  if (expected.port !== current.port) return false;
  if (expected.hostname === current.hostname) return true;

  return isLoopbackHost(expected.hostname) && isLoopbackHost(current.hostname);
}

function getAllowedActionHosts(expectedHost: string): Set<string> {
  const hosts = new Set<string>([expectedHost.toLowerCase()]);
  const raw = parseCsv(process.env.CONDUCTOR_ALLOWED_ORIGINS);

  for (const entry of raw) {
    if (!entry) continue;
    const candidate = entry.includes("://") ? entry : `https://${entry}`;
    const parsed = parseHostParts(candidate, expectedHost);
    if (parsed) {
      hosts.add(parsed.host.toLowerCase());
      continue;
    }
    hosts.add(entry.toLowerCase());
  }

  return hosts;
}

function isApproved(user: ClerkUser): boolean {
  const raw = user.publicMetadata ?? {};
  return raw.conductorApproved === true;
}

function envRequiresAuth(): boolean {
  return (process.env.CONDUCTOR_REQUIRE_AUTH ?? "").trim().toLowerCase() === "true";
}

function legacyRoleEnvFallback(): {
  allowedEmails: string[];
  allowedDomains: string[];
  adminEmails: string[];
} {
  return {
    allowedEmails: parseCsv(process.env.CONDUCTOR_ALLOWED_EMAILS),
    allowedDomains: parseCsv(process.env.CONDUCTOR_ALLOWED_DOMAINS),
    adminEmails: parseCsv(process.env.CONDUCTOR_ADMIN_EMAILS),
  };
}

function hasLegacyAllowListConfigured(): boolean {
  const { allowedEmails, allowedDomains, adminEmails } = legacyRoleEnvFallback();
  return allowedEmails.length > 0 || allowedDomains.length > 0 || adminEmails.length > 0;
}

function passesLegacyEmailRestrictions(email: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const { allowedEmails, allowedDomains, adminEmails } = legacyRoleEnvFallback();

  const emailAllowed =
    allowedEmails.length === 0 ||
    allowedEmails.includes(normalizedEmail) ||
    adminEmails.includes(normalizedEmail);

  const domainAllowed =
    allowedDomains.length === 0 ||
    allowedDomains.some((domain) => normalizedEmail.endsWith(`@${domain}`));

  return emailAllowed && domainAllowed;
}

async function loadAccessConfig(): Promise<DashboardAccessConfig | null> {
  try {
    const { config } = await getServices();
    return config.access ?? null;
  } catch {
    return null;
  }
}

function getDefaultRole(access: DashboardAccessConfig | null): DashboardRole | null {
  const configured = process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE?.trim().toLowerCase();
  if (configured === "viewer" || configured === "operator" || configured === "admin") {
    return configured;
  }
  return access?.defaultRole ?? null;
}

async function currentHeaders(request?: Request): Promise<Headers> {
  if (request) return request.headers;
  return headers();
}

async function currentHost(request?: Request): Promise<string> {
  if (request) {
    try {
      return new URL(request.url).hostname;
    } catch {
      return request.headers.get("host")?.split(":")[0]?.trim().toLowerCase() ?? "";
    }
  }
  const headerStore = await headers();
  return headerStore.get("host")?.split(":")[0]?.trim().toLowerCase() ?? "";
}

function resolveRoleForAuthenticatedEmail(
  email: string,
  access: DashboardAccessConfig | null,
): DashboardAccess {
  if (!passesLegacyEmailRestrictions(email)) {
    return {
      ok: false,
      authenticated: true,
      email,
      reason: "Email/domain not allowed",
    };
  }

  const defaultRole = getDefaultRole(access);
  const roleResolution = resolveRoleForEmail(
    email,
    defaultRole ? { ...access, defaultRole } : access,
    legacyRoleEnvFallback(),
  );

  if (!roleResolution.role) {
    return {
      ok: false,
      authenticated: true,
      email,
      reason: "Authenticated user is not granted dashboard access",
    };
  }

  return {
    ok: true,
    authenticated: true,
    email,
    role: roleResolution.role,
  };
}

async function resolveTrustedHeaderAccess(
  request: Request | undefined,
  access: DashboardAccessConfig | null,
): Promise<DashboardAccess | null> {
  const headerStore = await currentHeaders(request);
  const identity = await verifyTrustedEdgeIdentity(headerStore, access);
  if (!identity) return null;
  if (!identity.ok) {
    return {
      ok: false,
      authenticated: false,
      reason: identity.reason,
      provider: identity.provider,
    };
  }

  const resolved = resolveRoleForAuthenticatedEmail(identity.email, access);
  return {
    ...resolved,
    provider: identity.provider,
  };
}

async function resolveBuiltinRemoteAccess(): Promise<DashboardAccess | null> {
  if (!isBuiltinRemoteAuthEnabled()) return null;

  const cookieStore = await cookies();
  const session = cookieStore.get(BUILTIN_REMOTE_SESSION_COOKIE)?.value ?? null;
  if (!session) {
    return {
      ok: false,
      authenticated: false,
      reason: "Remote sign-in required",
      provider: "builtin",
    };
  }

  const validSession = await verifyBuiltinRemoteSession(session);
  if (!validSession) {
    return {
      ok: false,
      authenticated: false,
      reason: "Remote sign-in required",
      provider: "builtin",
    };
  }

  return {
    ok: true,
    authenticated: true,
    role: "admin",
    email: "builtin",
    provider: "builtin",
  };
}

async function resolveClerkAccess(access: DashboardAccessConfig | null): Promise<DashboardAccess | null> {
  if (!clerkConfigured) return null;

  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser() as ClerkUser | null;
    if (!user) {
      return {
        ok: false,
        authenticated: false,
        reason: "Not authenticated",
        provider: "clerk",
      };
    }

    const email = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress
      ?? user.emailAddresses[0]?.emailAddress
      ?? "";

    if (!email) {
      return {
        ok: false,
        authenticated: true,
        reason: "No email on account",
        provider: "clerk",
      };
    }

    const normalizedEmail = email.toLowerCase();
    const resolved = resolveRoleForAuthenticatedEmail(normalizedEmail, access);
    if (!resolved.ok) {
      return {
        ...resolved,
        provider: "clerk",
      };
    }

    const requireApproval = (process.env.CONDUCTOR_REQUIRE_APPROVAL ?? "true") === "true";
    const adminEmails = legacyRoleEnvFallback().adminEmails;
    if (requireApproval && !adminEmails.includes(normalizedEmail) && !isApproved(user)) {
      return {
        ok: false,
        authenticated: true,
        email: normalizedEmail,
        provider: "clerk",
        reason: "Awaiting manual approval",
      };
    }

    return {
      ...resolved,
      provider: "clerk",
    };
  } catch {
    return {
      ok: false,
      authenticated: false,
      reason: "Authentication service is unavailable. Check Clerk env vars and retry.",
      provider: "clerk",
    };
  }
}

export async function getDashboardAccess(request?: Request): Promise<DashboardAccess> {
  const access = await loadAccessConfig();
  const host = await currentHost(request);

  const trustedHeaderAccess = await resolveTrustedHeaderAccess(request, access);
  if (trustedHeaderAccess) return trustedHeaderAccess;

  const builtinAccess = await resolveBuiltinRemoteAccess();
  if (builtinAccess) return builtinAccess;

  const clerkAccess = await resolveClerkAccess(access);
  if (clerkAccess) return clerkAccess;

  const requireAuth = access?.requireAuth === true || envRequiresAuth() || hasLegacyAllowListConfigured();

  // Trust the configured dashboardUrl host (for remote access via tunnels like ngrok).
  let isTrustedDashboardHost = false;
  try {
    const { config } = await getServices();
    const configuredDashboardUrl = config.dashboardUrl?.trim();
    if (configuredDashboardUrl) {
      const dashboardHost = new URL(configuredDashboardUrl).hostname.toLowerCase();
      isTrustedDashboardHost = host.toLowerCase() === dashboardHost;
    }
  } catch {
    // Ignore config lookup errors and continue with default host checks.
  }

  if (!isLoopbackHost(host) && !isTrustedDashboardHost) {
    return {
      ok: false,
      authenticated: false,
      reason: "Authentication is required for non-local dashboard access",
    };
  }

  if (requireAuth) {
    return {
      ok: false,
      authenticated: false,
      reason: "Authentication required",
    };
  }

  return {
    ok: true,
    authenticated: false,
    role: "admin",
    email: "local",
    provider: "local",
  };
}

export async function guardApiAccess(
  request?: Request,
  requiredRole: DashboardRole = "viewer",
): Promise<NextResponse | null> {
  const access = await getDashboardAccess(request);
  if (!access.ok) {
    return NextResponse.json(
      {
        error: "Access denied",
        reason: access.reason,
        email: access.email ?? null,
      },
      { status: 403 },
    );
  }

  if (!access.role || !roleMeetsRequirement(access.role, requiredRole)) {
    return NextResponse.json(
      {
        error: "Insufficient permissions",
        reason: `Requires ${requiredRole} access`,
        email: access.email ?? null,
        role: access.role ?? null,
      },
      { status: 403 },
    );
  }

  return null;
}

function matchesHost(value: string, expectedHost: string, allowedHosts: Set<string>): boolean {
  const parsed = parseHostParts(value, expectedHost);
  if (!parsed) return false;
  if (allowedHosts.has(parsed.host.toLowerCase())) return true;
  return equivalentHost(parsed.host, expectedHost);
}

function guardActionOrigin(request: NextRequest): NextResponse | null {
  const expectedHost = request.nextUrl.host;
  if (!expectedHost) return null;
  const allowedHosts = getAllowedActionHosts(expectedHost);

  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite && secFetchSite !== "none" && secFetchSite !== "same-origin" && secFetchSite !== "same-site") {
    return NextResponse.json(
      {
        error: "Invalid request context",
        reason: "Cross-site requests are not allowed for agent-control actions.",
      },
      { status: 403 },
    );
  }

  const originHeader = request.headers.get("origin");
  const origin = originHeader && originHeader !== "null" ? originHeader : null;
  if (origin && !matchesHost(origin, expectedHost, allowedHosts)) {
    return NextResponse.json(
      {
        error: "Invalid request origin",
        reason: "Cross-origin requests are not allowed for agent-control actions.",
      },
      { status: 403 },
    );
  }

  const referer = request.headers.get("referer") ?? request.headers.get("referrer");
  if (!origin && referer && !matchesHost(referer, expectedHost, allowedHosts)) {
    return NextResponse.json(
      {
        error: "Invalid request origin",
        reason: "Cross-site requests are not allowed for agent-control actions.",
      },
      { status: 403 },
    );
  }

  return null;
}

export function guardApiActionAccess(request: NextRequest): NextResponse | null {
  return guardActionOrigin(request);
}
