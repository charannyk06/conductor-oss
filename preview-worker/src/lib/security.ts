import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import type { BridgePreviewSessionConfig } from "./types.js";

const LOCAL_NAVIGATION_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"] as const;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const BARE_LOCAL_NAVIGATION_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/.*)?$/i;
const MAX_DIRECT_RESPONSE_BYTES = 25 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface NavigationAddress {
  address: string;
  family: number;
}

export interface ResolvedDirectNavigationTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface DirectNavigationResolveOptions {
  allowLoopback?: boolean;
  resolver?: (hostname: string) => Promise<NavigationAddress[]>;
}

export interface DirectNavigationRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  timeoutMs: number;
  allowLoopback?: boolean;
  reserveBufferedBytes?: (bytes: number) => void;
}

export interface DirectNavigationResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

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
    || lower.startsWith("ff")
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

function isLoopbackAddress(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  const mappedIpv4 = normalized.toLowerCase().startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  return mappedIpv4 === "0.0.0.0" || mappedIpv4.startsWith("127.");
}

async function defaultResolver(hostname: string): Promise<NavigationAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true });
}

export async function resolveSafeDirectNavigationTarget(
  value: string,
  options: DirectNavigationResolveOptions = {},
): Promise<ResolvedDirectNavigationTarget> {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Preview navigation only supports HTTP and HTTPS targets.");
  }

  const hostname = normalizeNavigationHostname(parsed.hostname);
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await (options.resolver ?? defaultResolver)(hostname);
  if (resolved.length === 0) {
    throw new Error(`Preview navigation could not resolve ${hostname}.`);
  }

  const normalized = resolved.map((entry) => ({
    address: normalizeNavigationHostname(entry.address),
    family: entry.family === 6 ? 6 as const : 4 as const,
  }));
  const localHostAllowed = options.allowLoopback !== false && isLocalHost(hostname);
  if (localHostAllowed && normalized.some((entry) => !isLoopbackAddress(entry.address))) {
    throw new Error("Preview loopback navigation resolved outside the loopback interface and was blocked.");
  }

  if (
    !unsafePreviewHostsAllowed()
    && !localHostAllowed
    && normalized.some((entry) => hostnameResolvesToPrivateAddress(entry.address))
  ) {
    throw new Error(
      "Preview navigation resolved to a private network address and was blocked. Set CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS=true only if you intentionally trust that target.",
    );
  }

  const selected = normalized.find((entry) => entry.family === 4) ?? normalized[0];
  if (!selected) {
    throw new Error(`Preview navigation could not resolve ${hostname}.`);
  }
  return { url: parsed, address: selected.address, family: selected.family };
}

export async function assertSafeDirectNavigationTarget(
  value: string,
  options: DirectNavigationResolveOptions = {},
): Promise<void> {
  await resolveSafeDirectNavigationTarget(value, options);
}

function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || normalized === "host" || normalized === "content-length") continue;
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    sanitized[normalized] = value;
  }
  return sanitized;
}

function sanitizeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    sanitized[normalized] = value;
  }
  return sanitized;
}

export function buildPinnedRequestOptions(
  target: ResolvedDirectNavigationTarget,
  method: string,
  headers: Record<string, string>,
  bodyLength = 0,
): HttpsRequestOptions {
  const forwardedHeaders = sanitizeRequestHeaders(headers);
  forwardedHeaders.host = target.url.host;
  if (bodyLength > 0) {
    forwardedHeaders["content-length"] = String(bodyLength);
  }

  return {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
    method,
    path: `${target.url.pathname}${target.url.search}`,
    headers: forwardedHeaders,
    ...(target.url.protocol === "https:" && isIP(target.url.hostname) === 0
      ? { servername: target.url.hostname }
      : {}),
  };
}

export async function requestSafeDirectNavigation(
  input: DirectNavigationRequest,
): Promise<DirectNavigationResponse> {
  const target = await resolveSafeDirectNavigationTarget(input.url, {
    allowLoopback: input.allowLoopback ?? false,
  });
  const body = input.body ? Buffer.from(input.body) : Buffer.alloc(0);
  const requestOptions = buildPinnedRequestOptions(target, input.method, input.headers, body.length);
  const requestImpl = target.url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<DirectNavigationResponse>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      callback();
    };
    const outgoing = requestImpl(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_DIRECT_RESPONSE_BYTES) {
          response.destroy(new Error("Preview response exceeded the 25 MiB safety limit."));
          return;
        }
        try {
          input.reserveBufferedBytes?.(buffer.length);
        } catch (error) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", (error) => settle(() => reject(error)));
      response.once("end", () => {
        try {
          if (received > 0) {
            input.reserveBufferedBytes?.(received);
          }
          const result = {
            status: response.statusCode ?? 502,
            headers: sanitizeResponseHeaders(response.headers),
            body: Buffer.concat(chunks),
          };
          settle(() => resolve(result));
        } catch (error) {
          settle(() => reject(error));
        }
      });
    });
    deadline = setTimeout(() => {
      outgoing.destroy(new Error("Preview network request timed out."));
    }, input.timeoutMs);
    deadline.unref();
    outgoing.once("error", (error) => settle(() => reject(error)));
    if (body.length > 0) {
      outgoing.write(body);
    }
    outgoing.end();
  });
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
