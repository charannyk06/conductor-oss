import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DashboardAccessConfig, DashboardRole } from "@conductor-oss/core/types";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { resolveRoleForEmail, roleMeetsRequirement, isLoopbackHost } from "@/lib/accessControl";
import {
  getDefaultPostSignInRedirectTarget,
  buildHostedSignInPath,
  buildHostedSignInRedirectUrl,
  buildSignInPath,
  resolvePostSignInRedirectTarget,
} from "@/lib/authRedirect";
import { resolveClerkConfiguration, resolveRequestHostname } from "@/lib/clerkConfig";
import { verifyTrustedEdgeIdentity } from "@/lib/edgeAuth";
import { readRemoteAccessRuntimeState } from "@/lib/remoteAccessRuntime";
import { sanitizeRedirectTarget } from "@/lib/remoteAuth";

type DashboardIdentityProvider =
  | "local"
  | "clerk"
  | "tailscale"
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

function envRequiresPairedDeviceScope(): boolean {
  const value = (
    process.env.CONDUCTOR_REQUIRE_PAIRED_DEVICE
    ?? process.env.NEXT_PUBLIC_CONDUCTOR_REQUIRE_PAIRED_DEVICE
    ?? ""
  ).trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function requiresPairedDeviceScope(access: DashboardAccess): boolean {
  return envRequiresPairedDeviceScope() || Boolean(access.provider && access.provider !== "local");
}

export type DashboardConfigSnapshot = {
  access: DashboardAccessConfig | null;
  dashboardUrl: string | null;
};

const globalForDashboardConfig = globalThis as typeof globalThis & {
  _conductorDashboardConfig?: DashboardConfigSnapshot;
  _conductorDashboardConfigPath?: string | null;
  _conductorDashboardConfigMtimeMs?: number | null;
};

const DASHBOARD_CONFIG_FILENAMES = ["conductor.yaml", "conductor.yml"] as const;

function parseCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function parseDashboardRole(value: unknown): DashboardRole | undefined {
  return value === "viewer" || value === "operator" || value === "admin"
    ? value
    : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDashboardAccessConfig(value: unknown): DashboardAccessConfig | null {
  const payload = toObject(value);
  if (Object.keys(payload).length === 0) {
    return null;
  }

  const trustedHeaders = toObject(payload["trustedHeaders"]);
  const roles = toObject(payload["roles"]);

  return {
    requireAuth: payload["requireAuth"] === true ? true : undefined,
    allowSignedShareLinks: payload["allowSignedShareLinks"] === true ? true : undefined,
    defaultRole: parseDashboardRole(payload["defaultRole"]),
    trustedHeaders: Object.keys(trustedHeaders).length > 0
      ? {
        enabled: trustedHeaders["enabled"] === true ? true : undefined,
        provider: trustedHeaders["provider"] === "generic" || trustedHeaders["provider"] === "cloudflare-access"
          ? trustedHeaders["provider"]
          : undefined,
        emailHeader: typeof trustedHeaders["emailHeader"] === "string" ? trustedHeaders["emailHeader"] : undefined,
        jwtHeader: typeof trustedHeaders["jwtHeader"] === "string" ? trustedHeaders["jwtHeader"] : undefined,
        teamDomain: typeof trustedHeaders["teamDomain"] === "string" ? trustedHeaders["teamDomain"] : undefined,
        audience: typeof trustedHeaders["audience"] === "string" ? trustedHeaders["audience"] : undefined,
      }
      : undefined,
    roles: Object.keys(roles).length > 0
      ? {
        viewers: parseStringArray(roles["viewers"]),
        operators: parseStringArray(roles["operators"]),
        admins: parseStringArray(roles["admins"]),
        viewerDomains: parseStringArray(roles["viewerDomains"]),
        operatorDomains: parseStringArray(roles["operatorDomains"]),
        adminDomains: parseStringArray(roles["adminDomains"]),
      }
      : undefined,
  };
}

function resolveConfigFileInDirectory(directory: string): string | null {
  for (const filename of DASHBOARD_CONFIG_FILENAMES) {
    const configPath = resolve(directory, filename);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
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

function resolveDashboardConfigPath(): string | null {
  const envConfigPath = process.env.CO_CONFIG_PATH?.trim();
  if (envConfigPath) {
    const resolvedPath = resolve(envConfigPath);
    return existsSync(resolvedPath) ? resolvedPath : null;
  }

  const workspaceHint = process.env.CONDUCTOR_WORKSPACE?.trim();
  if (workspaceHint) {
    const resolvedHint = resolve(workspaceHint);
    if (/^conductor\.ya?ml$/i.test(basename(resolvedHint))) {
      return existsSync(resolvedHint) ? resolvedHint : null;
    }

    const workspaceConfigPath = resolveConfigFileInDirectory(resolvedHint);
    if (workspaceConfigPath) {
      return workspaceConfigPath;
    }
  }

  const cwd = process.cwd();
  const staticSearchRoots = [
    cwd,
    resolve(cwd, ".."),
    resolve(cwd, "../.."),
  ];

  for (const searchRoot of staticSearchRoots) {
    const configPath = resolveConfigFileInDirectory(searchRoot);
    if (configPath) {
      return configPath;
    }
  }

  return null;
}

function readDashboardConfigSnapshot(configPath: string): DashboardConfigSnapshot {
  const raw = parseYaml(readFileSync(configPath, "utf8")) as { access?: unknown; dashboardUrl?: unknown } | null;
  return {
    access: normalizeDashboardAccessConfig(raw?.access),
    dashboardUrl: typeof raw?.dashboardUrl === "string" && raw.dashboardUrl.trim().length > 0
      ? raw.dashboardUrl.trim()
      : null,
  };
}

function loadDashboardConfigSnapshot(): DashboardConfigSnapshot {
  const configPath = resolveDashboardConfigPath();
  const mtimeMs = configPath
    ? (() => {
        try {
          return statSync(configPath).mtimeMs;
        } catch {
          return null;
        }
      })()
    : null;

  if (
    globalForDashboardConfig._conductorDashboardConfig
    && globalForDashboardConfig._conductorDashboardConfigPath === configPath
    && globalForDashboardConfig._conductorDashboardConfigMtimeMs === mtimeMs
  ) {
    return globalForDashboardConfig._conductorDashboardConfig;
  }

  const fallback = { access: null, dashboardUrl: null };
  if (!configPath) {
    globalForDashboardConfig._conductorDashboardConfig = fallback;
    globalForDashboardConfig._conductorDashboardConfigPath = null;
    globalForDashboardConfig._conductorDashboardConfigMtimeMs = null;
    return fallback;
  }

  try {
    const snapshot = readDashboardConfigSnapshot(configPath);
    globalForDashboardConfig._conductorDashboardConfig = snapshot;
    globalForDashboardConfig._conductorDashboardConfigPath = configPath;
    globalForDashboardConfig._conductorDashboardConfigMtimeMs = mtimeMs;
    return snapshot;
  } catch {
    globalForDashboardConfig._conductorDashboardConfig = fallback;
    globalForDashboardConfig._conductorDashboardConfigPath = configPath;
    globalForDashboardConfig._conductorDashboardConfigMtimeMs = mtimeMs;
    return fallback;
  }
}

export function getDashboardConfigSnapshot(): DashboardConfigSnapshot {
  return loadDashboardConfigSnapshot();
}

export function allowBuiltinRemoteAccess(access: DashboardAccessConfig | null | undefined): boolean {
  void access;
  return false;
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
    const forwardedHost = resolveRequestHostname(request.headers);
    if (forwardedHost) {
      return forwardedHost;
    }

    try {
      return new URL(request.url).hostname.trim().toLowerCase();
    } catch {
      return "";
    }
  }
  const headerStore = await headers();
  return resolveRequestHostname(headerStore);
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

async function resolveTailscaleAccess(
  request: Request | undefined,
  access: DashboardAccessConfig | null,
  loopbackRequest: boolean,
): Promise<DashboardAccess | null> {
  const runtimeState = readRemoteAccessRuntimeState();
  const tailscaleRuntimeAvailable = runtimeState?.provider === "tailscale"
    && (runtimeState.status === "ready" || runtimeState.status === "starting")
    && Boolean(runtimeState.publicUrl);
  if (!tailscaleRuntimeAvailable) {
    return null;
  }

  const headerStore = await currentHeaders(request);
  const login = headerStore.get("Tailscale-User-Login")?.trim().toLowerCase() ?? "";
  if (!login) {
    if (loopbackRequest) {
      return null;
    }
    return {
      ok: false,
      authenticated: false,
      provider: "tailscale",
      reason: "Private network sign-in required",
    };
  }

  const resolved = resolveRoleForAuthenticatedEmail(login, access);
  return {
    ...resolved,
    provider: "tailscale",
  };
}

async function resolveClerkAccess(
  access: DashboardAccessConfig | null,
  hostname: string,
): Promise<DashboardAccess | null> {
  const clerkConfiguration = resolveClerkConfiguration(hostname);
  if (!clerkConfiguration.enabled) {
    if (clerkConfiguration.reason === "production-origin-mismatch") {
      return {
        ok: false,
        authenticated: false,
        reason: "Preview auth is misconfigured. Use Clerk development keys for this preview deployment or move it onto a conductross.com subdomain.",
        provider: "clerk",
      };
    }
    return null;
  }

  if (!clerkConfiguration.secretKeyAvailable) {
    return {
      ok: false,
      authenticated: false,
      reason: "Authentication service is unavailable. Check Clerk env vars and retry.",
      provider: "clerk",
    };
  }

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
  const dashboardConfig = loadDashboardConfigSnapshot();
  const access = dashboardConfig.access;
  const host = await currentHost(request);
  const loopbackRequest = isLoopbackHost(host);
  const localAccess: DashboardAccess = {
    ok: true,
    authenticated: false,
    role: "admin",
    email: "local",
    provider: "local",
  };

  const trustedHeaderAccess = await resolveTrustedHeaderAccess(request, access);
  if (trustedHeaderAccess) return trustedHeaderAccess;

  const tailscaleAccess = await resolveTailscaleAccess(request, access, loopbackRequest);
  if (tailscaleAccess) return tailscaleAccess;

  const clerkAccess = await resolveClerkAccess(access, host);
  if (clerkAccess) return clerkAccess;

  const requireAuth = access?.requireAuth === true || envRequiresAuth() || hasLegacyAllowListConfigured();

  if (!loopbackRequest) {
    return {
      ok: false,
      authenticated: false,
      reason: "Authentication is required for non-local dashboard access",
    };
  }

  if (requireAuth) return localAccess;

  return localAccess;
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

function resolveExpectedActionHost(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    const parsed = parseHostParts(
      `${forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https"}://${forwardedHost}`,
      request.nextUrl.host,
    );
    if (parsed?.host) {
      return parsed.host;
    }
  }

  return request.headers.get("host")?.trim() || request.nextUrl.host;
}

function guardActionOrigin(request: NextRequest): NextResponse | null {
  const expectedHost = resolveExpectedActionHost(request);
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

export async function resolveDashboardPageRedirect(
  currentPath: string,
  requiredRole: DashboardRole = "viewer",
): Promise<string | null> {
  const access = await getDashboardAccess();
  if (access.ok && access.role && roleMeetsRequirement(access.role, requiredRole)) {
    return null;
  }

  const nextPath = sanitizeRedirectTarget(currentPath);
  if (access.provider === "clerk" && !access.authenticated) {
    return buildSignInPath(nextPath);
  }

  const params = new URLSearchParams({ error: "unavailable" });
  if (nextPath !== "/") {
    params.set("next", nextPath);
  }
  return `/unlock?${params.toString()}`;
}

export {
  getDefaultPostSignInRedirectTarget,
  buildHostedSignInPath,
  buildHostedSignInRedirectUrl,
  buildSignInPath,
  resolvePostSignInRedirectTarget,
};
