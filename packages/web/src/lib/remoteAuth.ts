const BUILTIN_REMOTE_ACCESS_TOKEN_ENV = "CONDUCTOR_REMOTE_ACCESS_TOKEN";
const BUILTIN_REMOTE_SESSION_SECRET_ENV = "CONDUCTOR_REMOTE_SESSION_SECRET";

export const BUILTIN_REMOTE_SESSION_COOKIE = "conductor_session";
export const BUILTIN_REMOTE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function getAccessToken(): string | null {
  const token = process.env[BUILTIN_REMOTE_ACCESS_TOKEN_ENV]?.trim();
  return token && token.length > 0 ? token : null;
}

function getSessionSecret(): string | null {
  const secret = process.env[BUILTIN_REMOTE_SESSION_SECRET_ENV]?.trim();
  return secret && secret.length > 0 ? secret : null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toHex(new Uint8Array(signature));
}

export function isBuiltinRemoteAuthEnabled(): boolean {
  return Boolean(getAccessToken() && getSessionSecret());
}

export function sanitizeRedirectTarget(value: string | null | undefined): string {
  if (!value) return "/";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  return trimmed;
}

export function isValidBuiltinAccessToken(candidate: string | null | undefined): boolean {
  const configured = getAccessToken();
  if (!configured || !candidate) return false;
  return constantTimeEqual(configured, candidate.trim());
}

export async function createBuiltinRemoteSessionValue(): Promise<string> {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("Built-in remote session secret is not configured");
  }

  const expiresAt = Date.now() + BUILTIN_REMOTE_SESSION_TTL_SECONDS * 1000;
  const payload = String(expiresAt);
  const signature = await signPayload(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifyBuiltinRemoteSession(value: string | null | undefined): Promise<boolean> {
  const secret = getSessionSecret();
  if (!secret || !value) return false;

  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return false;

  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expiresAt = Number.parseInt(payload, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }

  const expected = await signPayload(payload, secret);
  return constantTimeEqual(expected, signature);
}

export function getBuiltinRemoteSessionCookieOptions(isSecure: boolean): {
  httpOnly: true;
  maxAge: number;
  path: string;
  sameSite: "lax";
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    maxAge: BUILTIN_REMOTE_SESSION_TTL_SECONDS,
  };
}
