import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BridgePreviewSessionConfig } from "./types.js";

const LOCAL_NAVIGATION_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"] as const;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const BARE_LOCAL_NAVIGATION_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/.*)?$/i;

export function normalizeNavigationHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

export function normalizeNavigationInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (URL_SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (BARE_LOCAL_NAVIGATION_PATTERN.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

export function isLocalHost(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  return LOCAL_NAVIGATION_HOSTS.includes(normalized as (typeof LOCAL_NAVIGATION_HOSTS)[number]);
}

function unsafePreviewHostsAllowed(): boolean {
  return process.env.CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS?.trim().toLowerCase() === "true";
}

function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split(".").map((segment) => Number.parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [first = -1, second = -1] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

export function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  const lower = normalized.toLowerCase();
  const mappedIpv4 = lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : null;
  return lower === "::"
    || lower === "::1"
    || lower.startsWith("fe8")
    || lower.startsWith("fe9")
    || lower.startsWith("fea")
    || lower.startsWith("feb")
    || lower.startsWith("fc")
    || lower.startsWith("fd")
    || (mappedIpv4 ? isPrivateIpv4Address(mappedIpv4) : false);
}

function hostnameResolvesToPrivateAddress(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4Address(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateNetworkHostname(normalized);
  }
  return false;
}

export async function assertSafeDirectNavigationTarget(value: string): Promise<void> {
  if (unsafePreviewHostsAllowed()) {
    return;
  }

  const parsed = new URL(value);
  if (isLocalHost(parsed.hostname)) {
    return;
  }

  if (hostnameResolvesToPrivateAddress(parsed.hostname)) {
    throw new Error(
      "Preview navigation to private network hosts is blocked. Use loopback URLs for local dev servers or set CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS=true to override.",
    );
  }

  const resolved = await lookup(parsed.hostname, { all: true, verbatim: true }).catch(() => []);
  if (resolved.some((entry) => hostnameResolvesToPrivateAddress(entry.address))) {
    throw new Error(
      "Preview navigation resolved to a private network address and was blocked. Set CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS=true only if you intentionally trust that target.",
    );
  }
}

export type PreviewNavigationMode = "bridge" | "direct" | "blocked";

export function resolvePreviewNavigationMode(
  value: string,
  bridgePreview: Pick<BridgePreviewSessionConfig, "allowedOrigins"> | null,
): PreviewNavigationMode {
  if (!bridgePreview) {
    return "direct";
  }

  try {
    const parsed = new URL(value);
    const isLocal = isLocalHost(normalizeNavigationHostname(parsed.hostname));
    if (bridgePreview.allowedOrigins.includes(parsed.origin)) {
      return "bridge";
    }
    return isLocal ? "blocked" : "direct";
  } catch {
    return "direct";
  }
}

export function buildPreviewNavigationCandidates(value: string): string[] {
  const normalizedInput = normalizeNavigationInput(value);
  try {
    const parsed = new URL(normalizedInput);
    const normalized = parsed.toString();
    const hostname = normalizeNavigationHostname(parsed.hostname);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(
        `Navigation blocked: only http and https URLs are allowed. Got protocol "${parsed.protocol}".`,
      );
    }

    if (isLocalHost(hostname)) {
      const variants = new Set<string>([normalized]);
      for (const loopbackHost of LOCAL_NAVIGATION_HOSTS) {
        const candidate = new URL(normalized);
        candidate.hostname = loopbackHost;
        variants.add(candidate.toString());
      }
      return [...variants];
    }

    return [normalized];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Navigation blocked:")) {
      throw error;
    }
    throw new Error(
      `Navigation blocked: could not parse "${normalizedInput}" as a valid URL.`,
    );
  }
}
