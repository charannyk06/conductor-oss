import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type {
  DashboardAccessConfig,
  TrustedHeaderAccessProvider,
} from "@conductor-oss/core/types";

export type TrustedEdgeAuthProvider = "trusted-header" | "cloudflare-access";

export type TrustedEdgeAuthConfig = {
  enabled: boolean;
  provider: TrustedHeaderAccessProvider;
  emailHeader: string;
  jwtHeader: string;
  teamDomain: string | null;
  audience: string | null;
};

export type TrustedEdgeIdentity =
  | {
      ok: true;
      email: string;
      provider: TrustedEdgeAuthProvider;
    }
  | {
      ok: false;
      reason: string;
      provider: TrustedEdgeAuthProvider;
    };

const DEFAULT_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";
const DEFAULT_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const CLOUDFLARE_PROVIDER = "cloudflare-access";
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTeamDomain(value: string | null | undefined): string | null {
  const trimmed = normalizeValue(value);
  if (!trimmed) return null;

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/g, "")
      .toLowerCase();
  }
}

function getProvider(
  access: DashboardAccessConfig | null | undefined,
  teamDomain: string | null,
  audience: string | null,
): TrustedHeaderAccessProvider {
  const provider =
    normalizeValue(process.env.CONDUCTOR_TRUST_AUTH_PROVIDER)?.toLowerCase()
    || access?.trustedHeaders?.provider
    || (teamDomain || audience ? CLOUDFLARE_PROVIDER : null);

  return provider === "generic" ? "generic" : CLOUDFLARE_PROVIDER;
}

export function resolveTrustedEdgeAuthConfig(
  access: DashboardAccessConfig | null | undefined,
): TrustedEdgeAuthConfig {
  const teamDomain = normalizeTeamDomain(
    process.env.CONDUCTOR_CLOUDFLARE_ACCESS_TEAM_DOMAIN
    ?? access?.trustedHeaders?.teamDomain,
  );
  const audience = normalizeValue(
    process.env.CONDUCTOR_CLOUDFLARE_ACCESS_AUDIENCE
    ?? access?.trustedHeaders?.audience,
  );

  return {
    enabled:
      access?.trustedHeaders?.enabled === true
      || (process.env.CONDUCTOR_TRUST_AUTH_HEADERS ?? "").trim().toLowerCase() === "true",
    provider: getProvider(access, teamDomain, audience),
    emailHeader:
      normalizeValue(process.env.CONDUCTOR_TRUST_AUTH_EMAIL_HEADER)
      ?? normalizeValue(access?.trustedHeaders?.emailHeader)
      ?? DEFAULT_EMAIL_HEADER,
    jwtHeader:
      normalizeValue(process.env.CONDUCTOR_TRUST_AUTH_JWT_HEADER)
      ?? normalizeValue(access?.trustedHeaders?.jwtHeader)
      ?? DEFAULT_JWT_HEADER,
    teamDomain,
    audience,
  };
}

function getCloudflareJwks(teamDomain: string) {
  const cached = jwksCache.get(teamDomain);
  if (cached) return cached;

  const next = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
  );
  jwksCache.set(teamDomain, next);
  return next;
}

function extractEmailFromPayload(payload: JWTPayload): string | null {
  const emailClaim = payload.email;
  if (typeof emailClaim === "string" && emailClaim.trim().length > 0) {
    return emailClaim.trim().toLowerCase();
  }

  const subClaim = payload.sub;
  if (typeof subClaim === "string" && subClaim.includes("@")) {
    return subClaim.trim().toLowerCase();
  }

  return null;
}

function formatJwtError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Cloudflare Access token verification failed";
}

export async function verifyTrustedEdgeIdentity(
  headers: Headers,
  access: DashboardAccessConfig | null | undefined,
): Promise<TrustedEdgeIdentity | null> {
  const config = resolveTrustedEdgeAuthConfig(access);
  if (!config.enabled) return null;

  if (config.provider !== CLOUDFLARE_PROVIDER) {
    const legacyEmail = headers.get(config.emailHeader)?.trim().toLowerCase() ?? "";
    if (!legacyEmail) return null;
    return {
      ok: false,
      reason: "Generic trusted-header mode has been removed. Configure verified Cloudflare Access instead.",
      provider: "trusted-header",
    };
  }

  const assertion = headers.get(config.jwtHeader)?.trim() ?? "";
  if (!assertion) return null;

  if (!config.teamDomain || !config.audience) {
    return {
      ok: false,
      reason: "Cloudflare Access is enabled but team domain or audience is missing.",
      provider: "cloudflare-access",
    };
  }

  try {
    const { payload } = await jwtVerify(assertion, getCloudflareJwks(config.teamDomain), {
      audience: config.audience,
      issuer: `https://${config.teamDomain}`,
    });
    const email = extractEmailFromPayload(payload);
    if (!email) {
      return {
        ok: false,
        reason: "Cloudflare Access token is missing an email claim.",
        provider: "cloudflare-access",
      };
    }

    const assertedEmail = headers.get(config.emailHeader)?.trim().toLowerCase() ?? "";
    if (assertedEmail && assertedEmail !== email) {
      return {
        ok: false,
        reason: "Cloudflare Access email header does not match the verified token.",
        provider: "cloudflare-access",
      };
    }

    return {
      ok: true,
      email,
      provider: "cloudflare-access",
    };
  } catch (error) {
    return {
      ok: false,
      reason: formatJwtError(error),
      provider: "cloudflare-access",
    };
  }
}
