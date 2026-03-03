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

function matchesHost(value: string, expectedHost: string): boolean {
  try {
    const parsed = new URL(value, `https://${expectedHost}`);
    return parsed.host === expectedHost;
  } catch {
    return false;
  }
}

function guardActionOrigin(request: NextRequest): NextResponse | null {
  const expectedHost = request.nextUrl.host;
  if (!expectedHost) return null;

  const origin = request.headers.get("origin");
  if (origin && !matchesHost(origin, expectedHost)) {
    return NextResponse.json(
      {
        error: "Invalid request origin",
        reason: "Cross-origin requests are not allowed for agent-control actions.",
      },
      { status: 403 },
    );
  }

  const referer = request.headers.get("referer") ?? request.headers.get("referrer");
  if (!origin && referer && !matchesHost(referer, expectedHost)) {
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
