export const BUILTIN_REMOTE_SESSION_COOKIE = "conductor_session";
export const BUILTIN_REMOTE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function getBuiltinRemoteAccessToken(): string | null {
  return null;
}

export function isBuiltinRemoteAuthEnabled(): boolean {
  return false;
}

export function sanitizeRedirectTarget(value: string | null | undefined): string {
  if (!value) return "/";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  return trimmed;
}

export function isValidBuiltinAccessToken(candidate: string | null | undefined): boolean {
  void candidate;
  return false;
}

export async function createBuiltinRemoteSessionValue(): Promise<string> {
  throw new Error("Public share-link remote access has been removed.");
}

export async function verifyBuiltinRemoteSession(value: string | null | undefined): Promise<boolean> {
  void value;
  return false;
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
