import { isLoopbackHost } from "@/lib/accessControl";

export type ClerkConfigurationReason =
  | "missing-keys"
  | "hosted-development-keys";

export type ClerkConfiguration = {
  enabled: boolean;
  publishableKey: string | null;
  proxyUrl: string | null;
  clerkJSUrl: string | null;
  reason: ClerkConfigurationReason | null;
};

function normalizeEnvValue(value?: string | null): string {
  return (value ?? "").trim();
}

function decodeBase64Url(value: string): string | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized.padEnd(normalized.length + padding, "=");

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function resolveClerkFrontendApiUrl(): string | null {
  const explicitUrl = normalizeEnvValue(process.env.CLERK_FAPI_URL);
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/, "");
  }

  const publishableKey = normalizeEnvValue(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const match = publishableKey.match(/^pk_(?:test|live)_(.+)$/);
  if (!match) {
    return null;
  }

  const decoded = decodeBase64Url(match[1]);
  if (!decoded) {
    return null;
  }

  const frontendApiHost = decoded.replace(/\$+$/, "").trim().replace(/\/+$/, "");
  if (!frontendApiHost) {
    return null;
  }

  if (frontendApiHost.startsWith("https://") || frontendApiHost.startsWith("http://")) {
    return frontendApiHost.replace(/\/+$/, "");
  }

  return `https://${frontendApiHost}`;
}

export function isDevelopmentClerkKey(value?: string | null): boolean {
  const normalized = normalizeEnvValue(value);
  return normalized.startsWith("pk_test_") || normalized.startsWith("sk_test_");
}

export function resolveRequestHostname(headerStore: Headers): string {
  const forwardedHost = headerStore.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || headerStore.get("host")?.trim() || "";
  return requestHost.split(":")[0]?.trim().toLowerCase() ?? "";
}

export function resolveRequestBaseUrl(headerStore: Headers): string | null {
  const forwardedHost = headerStore.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || headerStore.get("host")?.trim() || "";
  if (!requestHost) return null;

  const forwardedProto = headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : "https";

  return `${protocol}://${requestHost}`;
}

export function resolveClerkConfiguration(hostname?: string | null, baseUrl?: string | null): ClerkConfiguration {
  const publishableKey = normalizeEnvValue(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) || null;
  const secretKey = normalizeEnvValue(process.env.CLERK_SECRET_KEY);
  const trimmedBaseUrl = normalizeEnvValue(baseUrl) || null;

  if (!publishableKey || !secretKey) {
    return {
      enabled: false,
      publishableKey,
      proxyUrl: null,
      clerkJSUrl: null,
      reason: "missing-keys",
    };
  }

  if (!isLoopbackHost(hostname) && (isDevelopmentClerkKey(publishableKey) || isDevelopmentClerkKey(secretKey))) {
    return {
      enabled: false,
      publishableKey,
      proxyUrl: null,
      clerkJSUrl: null,
      reason: "hosted-development-keys",
    };
  }

  const shouldProxyFrontendApi = !isLoopbackHost(hostname) && Boolean(trimmedBaseUrl);
  const proxyUrl = shouldProxyFrontendApi ? `${trimmedBaseUrl}/__clerk` : null;
  const clerkJSUrl = proxyUrl ? `${proxyUrl}/npm/@clerk/clerk-js@5/dist/clerk.browser.js` : null;

  return {
    enabled: true,
    publishableKey,
    proxyUrl,
    clerkJSUrl,
    reason: null,
  };
}
