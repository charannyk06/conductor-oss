const DEFAULT_LOCAL_BRIDGE_RELAY_URL = "http://127.0.0.1:8080";

function normalizeHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function resolveBridgeRelayUrl(): string | null {
  const explicitRelayUrl = normalizeHttpUrl(
    process.env.CONDUCTOR_BRIDGE_RELAY_URL ?? process.env.NEXT_PUBLIC_CONDUCTOR_BRIDGE_RELAY_URL,
  );
  if (explicitRelayUrl) {
    return explicitRelayUrl;
  }

  if (process.env.NODE_ENV === "development") {
    return DEFAULT_LOCAL_BRIDGE_RELAY_URL;
  }

  return null;
}

export function requireBridgeRelayUrl(): string {
  const relayUrl = resolveBridgeRelayUrl();
  if (!relayUrl) {
    throw new Error("Bridge relay URL is not configured");
  }
  return relayUrl;
}
