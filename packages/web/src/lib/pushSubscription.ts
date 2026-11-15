/** Helpers for Web Push subscription management in the dashboard. */

export type PushSupportState = "unsupported" | "default" | "denied" | "granted";

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Decodes a base64url (or plain base64) string, as used for VAPID public keys. */
export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An uncompressed P-256 point is 65 bytes starting with 0x04. */
export function isValidVapidPublicKey(value: string): boolean {
  try {
    const bytes = base64UrlToUint8Array(value);
    return bytes.length === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}

type SubscriptionJson = {
  endpoint?: string | null;
  keys?: Record<string, string | undefined> | null;
};

/** Extracts the fields the backend stores from `PushSubscription.toJSON()`. */
export function toPushSubscriptionPayload(json: SubscriptionJson | null | undefined): PushSubscriptionPayload | null {
  const endpoint = json?.endpoint?.trim();
  const p256dh = json?.keys?.p256dh?.trim();
  const auth = json?.keys?.auth?.trim();
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

export function resolvePushSupportState(env: {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: string | null;
}): PushSupportState {
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return "unsupported";
  }
  if (env.permission === "granted") return "granted";
  if (env.permission === "denied") return "denied";
  return "default";
}
