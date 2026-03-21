import { isLoopbackHost } from "@/lib/accessControl";

export type ClerkConfigurationReason =
  | "missing-publishable-key"
  | "production-origin-mismatch";

export type ClerkConfiguration = {
  enabled: boolean;
  publishableKey: string | null;
  secretKeyAvailable: boolean;
  proxyUrl: string | null;
  clerkJSUrl: string | null;
  signInUrl: string | null;
  signUpUrl: string | null;
  hostedSignInUrl: string | null;
  allowedRedirectOrigins: string[];
  reason: ClerkConfigurationReason | null;
};

function normalizeEnvValue(value?: string | null): string {
  return (value ?? "").trim();
}

function normalizeHostname(value?: string | null): string {
  return normalizeEnvValue(value).toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizeOrigin(value?: string | null): string | null {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return null;
  }

  const candidate = normalized.includes("://") ? normalized : `https://${normalized}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeProxyUrl(value?: string | null): string | null {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("/")) {
    const trimmed = normalized.replace(/\/+$/, "");
    return trimmed || "/";
  }

  const candidate = normalized.includes("://") ? normalized : `https://${normalized}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname || ""}`;
  } catch {
    return null;
  }
}

function normalizeRedirectUrl(value?: string | null): string | null {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("/")) {
    const trimmed = normalized.replace(/\/+$/, "");
    return trimmed || "/";
  }

  const candidate = normalized.includes("://") ? normalized : `https://${normalized}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname || ""}`;
  } catch {
    return null;
  }
}

function resolveAllowedRedirectOrigins(baseUrl?: string | null): string[] {
  const origins = new Set<string>();

  const addOrigin = (value?: string | null) => {
    const origin = normalizeOrigin(value);
    if (origin) {
      origins.add(origin);
    }
  };

  addOrigin(baseUrl);

  for (const entry of normalizeEnvValue(process.env.CONDUCTOR_ALLOWED_ORIGINS).split(",")) {
    addOrigin(entry);
  }

  return [...origins];
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

function resolveCompatibleHostSuffix(frontendApiUrl: string | null): string | null {
  if (!frontendApiUrl) {
    return null;
  }

  try {
    const hostname = new URL(frontendApiUrl).hostname.toLowerCase();
    const parts = hostname.split(".").filter(Boolean);
    if (parts.length <= 2) {
      return hostname;
    }
    return parts.slice(1).join(".");
  } catch {
    return null;
  }
}

function requestHostMatchesFrontendApi(hostname: string | null | undefined, frontendApiUrl: string | null): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname || isLoopbackHost(normalizedHostname)) {
    return true;
  }

  const compatibleSuffix = resolveCompatibleHostSuffix(frontendApiUrl);
  if (!compatibleSuffix) {
    return true;
  }

  return normalizedHostname === compatibleSuffix || normalizedHostname.endsWith(`.${compatibleSuffix}`);
}

function resolveConfiguredProxyUrl(): string | null {
  return normalizeProxyUrl(
    process.env.NEXT_PUBLIC_CLERK_PROXY_URL
    ?? process.env.CLERK_PROXY_URL,
  );
}

function resolveConfiguredSignInUrl(): string | null {
  return normalizeRedirectUrl(
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL
    ?? process.env.CLERK_SIGN_IN_URL,
  );
}

function resolveConfiguredSignUpUrl(): string | null {
  return normalizeRedirectUrl(
    process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL
    ?? process.env.CLERK_SIGN_UP_URL,
  );
}

function resolveConfiguredHostedSignInUrl(): string | null {
  return normalizeRedirectUrl(
    process.env.NEXT_PUBLIC_CLERK_HOSTED_SIGN_IN_URL
    ?? process.env.CLERK_HOSTED_SIGN_IN_URL,
  );
}

function normalizeAppAuthUrl(
  configuredUrl: string | null,
  baseUrl: string | null | undefined,
  fallbackUrl: string | null,
): string | null {
  if (!configuredUrl) {
    return fallbackUrl;
  }

  if (configuredUrl.startsWith("/")) {
    return configuredUrl;
  }

  const normalizedBaseUrl = normalizeEnvValue(baseUrl);
  if (!normalizedBaseUrl) {
    return fallbackUrl;
  }

  try {
    const targetUrl = new URL(configuredUrl);
    const currentBaseUrl = new URL(normalizedBaseUrl);
    if (targetUrl.origin !== currentBaseUrl.origin) {
      return fallbackUrl;
    }

    const pathname = targetUrl.pathname.replace(/\/+$/, "");
    return pathname || "/";
  } catch {
    return fallbackUrl;
  }
}

function normalizeHostedAuthUrl(
  configuredUrl: string | null,
  baseUrl: string | null | undefined,
): string | null {
  if (!configuredUrl || configuredUrl.startsWith("/")) {
    return null;
  }

  const normalizedBaseUrl = normalizeEnvValue(baseUrl);
  try {
    const targetUrl = new URL(configuredUrl);
    if (!normalizedBaseUrl) {
      return configuredUrl;
    }

    const currentBaseUrl = new URL(normalizedBaseUrl);
    return targetUrl.origin === currentBaseUrl.origin ? null : configuredUrl;
  } catch {
    return null;
  }
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
  const allowedRedirectOrigins = resolveAllowedRedirectOrigins(trimmedBaseUrl);
  const secretKeyAvailable = Boolean(secretKey);

  if (!publishableKey) {
    return {
      enabled: false,
      publishableKey,
      secretKeyAvailable,
      proxyUrl: null,
      clerkJSUrl: null,
      signInUrl: null,
      signUpUrl: null,
      hostedSignInUrl: null,
      allowedRedirectOrigins,
      reason: "missing-publishable-key",
    };
  }

  const configuredProxyUrl = resolveConfiguredProxyUrl();
  const frontendApiUrl = resolveClerkFrontendApiUrl();
  if (
    !configuredProxyUrl
    && !isDevelopmentClerkKey(publishableKey)
    && !requestHostMatchesFrontendApi(hostname, frontendApiUrl)
  ) {
    return {
      enabled: false,
      publishableKey,
      secretKeyAvailable,
      proxyUrl: null,
      clerkJSUrl: null,
      signInUrl: null,
      signUpUrl: null,
      hostedSignInUrl: null,
      allowedRedirectOrigins,
      reason: "production-origin-mismatch",
    };
  }

  const configuredSignInUrl = resolveConfiguredSignInUrl();
  const configuredSignUpUrl = resolveConfiguredSignUpUrl();
  const configuredHostedSignInUrl = resolveConfiguredHostedSignInUrl();
  const signInUrl = normalizeAppAuthUrl(configuredSignInUrl, trimmedBaseUrl, "/sign-in");
  const signUpUrl = normalizeAppAuthUrl(configuredSignUpUrl, trimmedBaseUrl, null);
  const hostedSignInUrl = normalizeHostedAuthUrl(
    configuredHostedSignInUrl ?? configuredSignInUrl,
    trimmedBaseUrl,
  );
  // Only enable proxy mode when it is explicitly configured for the current deployment.
  // Some hosted environments share a Clerk instance that accepts the custom Frontend API
  // domain directly but rejects per-host proxy handshakes.
  const shouldProxyFrontendApi = !isLoopbackHost(hostname) && Boolean(configuredProxyUrl);
  const proxyUrl = shouldProxyFrontendApi ? configuredProxyUrl : null;
  const clerkJSUrl = proxyUrl ? `${proxyUrl}/npm/@clerk/clerk-js@5/dist/clerk.browser.js` : null;

  return {
    enabled: true,
    publishableKey,
    secretKeyAvailable,
    proxyUrl,
    clerkJSUrl,
    signInUrl,
    signUpUrl,
    hostedSignInUrl,
    allowedRedirectOrigins,
    reason: null,
  };
}
