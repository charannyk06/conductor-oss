import { SignJWT } from "jose";
import type { DashboardAccess } from "@/lib/auth";
import { requireBridgeRelayUrl } from "@/lib/bridgeRelayUrl";

const DEFAULT_LOCAL_BRIDGE_USER_ID = "local-admin";

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

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

export async function signBridgeRelayJwt(userId: string): Promise<string> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("Bridge relay user id is required");
  }

  const secret = process.env.RELAY_JWT_SECRET?.trim();
  const expirationSeconds = Math.floor(Date.now() / 1000) + 5 * 60;

  if (secret) {
    return await new SignJWT({
      sub: trimmedUserId,
      user_id: trimmedUserId,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(new TextEncoder().encode(secret));
  }

  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: trimmedUserId,
    user_id: trimmedUserId,
    exp: expirationSeconds,
  }));
  return `${header}.${payload}.`;
}

export function buildBridgeRelayWebSocketUrl(pathname: string, jwt: string): string {
  const relayUrl = new URL(requireBridgeRelayUrl());
  relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
  relayUrl.pathname = pathname;
  relayUrl.search = "";
  relayUrl.searchParams.set("jwt", jwt);
  relayUrl.hash = "";
  return relayUrl.toString();
}
