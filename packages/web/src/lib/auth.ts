import { NextRequest, NextResponse } from "next/server";

const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

export interface DashboardAccess {
  ok: boolean;
  email?: string;
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "[::1]";
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

type ClerkUser = {
  emailAddresses: { id: string; emailAddress: string }[];
  primaryEmailAddressId: string | null;
  publicMetadata: Record<string, unknown>;
};

function isApproved(user: ClerkUser): boolean {
  const raw = user.publicMetadata ?? {};
  return raw.conductorApproved === true;
}

export async function getDashboardAccess(): Promise<DashboardAccess> {
  if (!clerkConfigured) {
    return { ok: true, email: "local" };
  }

  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser() as ClerkUser | null;
    if (!user) return { ok: false, reason: "Not authenticated" };

    const email = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress
      ?? user.emailAddresses[0]?.emailAddress
      ?? "";

    if (!email) return { ok: false, reason: "No email on account" };

    const normalizedEmail = email.toLowerCase();
    const allowedEmails = parseCsv(process.env.CONDUCTOR_ALLOWED_EMAILS);
    const adminEmails = parseCsv(process.env.CONDUCTOR_ADMIN_EMAILS);
    const allowedDomains = parseCsv(process.env.CONDUCTOR_ALLOWED_DOMAINS);
    const requireApproval = (process.env.CONDUCTOR_REQUIRE_APPROVAL ?? "true") === "true";

    const emailAllowed =
      allowedEmails.length === 0 ||
      allowedEmails.includes(normalizedEmail) ||
      adminEmails.includes(normalizedEmail);

    const domainAllowed =
      allowedDomains.length === 0 ||
      allowedDomains.some((d) => normalizedEmail.endsWith(`@${d}`));

    if (!emailAllowed || !domainAllowed) {
      return { ok: false, email: normalizedEmail, reason: "Email/domain not allowed" };
    }

    if (requireApproval && !adminEmails.includes(normalizedEmail) && !isApproved(user)) {
      return { ok: false, email: normalizedEmail, reason: "Awaiting manual approval" };
    }

    return { ok: true, email: normalizedEmail };
  } catch {
    return {
      ok: false,
      reason:
        "Authentication service is unavailable. Check Clerk env vars and retry.",
    };
  }
}

export async function guardApiAccess(): Promise<NextResponse | null> {
  const access = await getDashboardAccess();
  if (access.ok) return null;
  return NextResponse.json(
    {
      error: "Access denied",
      reason: access.reason,
      email: access.email ?? null,
    },
    { status: 403 },
  );
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

/**
 * Guard mutating dashboard actions against simple CSRF-style origin/referer abuse.
 *
 * We keep this header-based check intentionally conservative: allow requests with
 * missing origin/referer headers (API clients), but block obvious cross-site calls.
 */
export function guardApiActionAccess(request: NextRequest): NextResponse | null {
  return guardActionOrigin(request);
}
