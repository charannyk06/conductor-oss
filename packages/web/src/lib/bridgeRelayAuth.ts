import { SignJWT } from "jose";
import { getDashboardAccess, type DashboardAccess } from "@/lib/auth";
import { requireBridgeRelayUrl } from "@/lib/bridgeRelayUrl";

const DEFAULT_LOCAL_BRIDGE_USER_ID = "local-admin";
const RELAY_JWT_ISSUER = "conductor-dashboard";
const RELAY_JWT_AUDIENCE = "conductor-relay";
const LEGACY_PROXY_AUTHORIZED_HEADER = "x-conductor-proxy-authorized";
const LEGACY_PROXY_EMAIL_HEADER = "x-conductor-access-email";
const LEGACY_PROXY_LOCAL_USER_HEADER = "x-bridge-user-id";

export type BridgeRelayJwtScope = "dashboard-api" | "terminal-browser";

export function resolveBridgeRelayUserId(access: DashboardAccess): string | null {
  const email = access.email?.trim().toLowerCase();
  if (email) {
    return email;
  }
  if (access.provider === "local") {
    return DEFAULT_LOCAL_BRIDGE_USER_ID;
  }
  return null;
}

export function appendLegacyBridgeRelayAuthHeaders(
  headers: Headers,
  access: DashboardAccess,
  userId: string,
): Headers {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return headers;
  }

  headers.set(LEGACY_PROXY_AUTHORIZED_HEADER, "true");
  if (access.provider === "local") {
    headers.set(LEGACY_PROXY_LOCAL_USER_HEADER, trimmedUserId);
    return headers;
  }

  headers.set(LEGACY_PROXY_EMAIL_HEADER, trimmedUserId);
  return headers;
}

function requireBridgeRelaySecret(): string {
  const secret = process.env.RELAY_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("RELAY_JWT_SECRET is required for bridge relay access");
  }
  return secret;
}

export async function signBridgeRelayJwt(
  userId: string,
  scope: BridgeRelayJwtScope,
  expiresIn: string = "5m",
): Promise<string> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("Bridge relay user id is required");
  }

  const secret = requireBridgeRelaySecret();
  return await new SignJWT({
    sub: trimmedUserId,
    user_id: trimmedUserId,
    scope,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(RELAY_JWT_ISSUER)
    .setAudience(RELAY_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

export async function buildBridgeRelayAuthHeaders(
  request: Request,
  scope: BridgeRelayJwtScope = "dashboard-api",
): Promise<Headers> {
  const access = await getDashboardAccess(request);
  const userId = resolveBridgeRelayUserId(access);
  if (!userId) {
    throw new Error("Unable to resolve the dashboard user for the bridge relay.");
  }

  const headers = new Headers({
    Authorization: `Bearer ${await signBridgeRelayJwt(userId, scope)}`,
  });
  return appendLegacyBridgeRelayAuthHeaders(headers, access, userId);
}

export function buildBridgeRelayWebSocketUrl(pathname: string, jwt?: string): string {
  const relayUrl = new URL(requireBridgeRelayUrl());
  relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
  relayUrl.pathname = pathname;
  relayUrl.search = "";
  relayUrl.hash = "";
  const trimmedJwt = jwt?.trim();
  if (trimmedJwt) {
    relayUrl.searchParams.set("jwt", trimmedJwt);
  }
  return relayUrl.toString();
}
