import type { DashboardAccessConfig } from "@conductor-oss/core/types";
import { isLoopbackHost } from "./accessControl";

export type RemoteAccessMode =
  | "cloudflare-access"
  | "private-network"
  | "enterprise-only"
  | "generic-header"
  | "clerk"
  | "local-only"
  | "misconfigured"
  | "unsafe-public";

export type RemoteAccessSummary = {
  publicUrl: string | null;
  connectUrl: string | null;
  shareable: boolean;
  mode: RemoteAccessMode;
  title: string;
  description: string;
  warnings: string[];
  nextSteps: string[];
};

type ResolveRemoteAccessSummaryInput = {
  access?: DashboardAccessConfig | null;
  clerkConfigured?: boolean;
  configuredPublicUrl?: string | null;
  managedProvider?: "tailscale" | null;
  observedPublicUrl?: string | null;
  preferredProvider?: "tailscale" | null;
  preferredProviderConnected?: boolean;
};

function hasVerifiedCloudflareAccess(access?: DashboardAccessConfig | null): boolean {
  const trustedHeaders = access?.trustedHeaders;
  return trustedHeaders?.enabled === true
    && trustedHeaders.provider !== "generic"
    && Boolean(trustedHeaders.teamDomain?.trim())
    && Boolean(trustedHeaders.audience?.trim());
}

function normalizePublicBaseUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (isLoopbackHost(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveRequestPublicUrl(request: Request): string | null {
  try {
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    const protocol = forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : requestUrl.protocol.replace(/:$/, "");
    const host = forwardedHost || request.headers.get("host")?.trim() || requestUrl.host;
    return normalizePublicBaseUrl(`${protocol}://${host}`);
  } catch {
    return null;
  }
}

export function resolveRemoteAccessSummary({
  access,
  clerkConfigured = false,
  configuredPublicUrl,
  managedProvider = null,
  observedPublicUrl,
  preferredProvider = null,
  preferredProviderConnected = false,
}: ResolveRemoteAccessSummaryInput): RemoteAccessSummary {
  const verifiedCloudflareAccess = hasVerifiedCloudflareAccess(access);
  const allowConfiguredPublicUrl = managedProvider === "tailscale" || verifiedCloudflareAccess || clerkConfigured;
  const publicUrl = (allowConfiguredPublicUrl ? normalizePublicBaseUrl(configuredPublicUrl) : null)
    ?? normalizePublicBaseUrl(observedPublicUrl);
  const trustedHeaders = access?.trustedHeaders;
  const trustedHeaderEnabled = trustedHeaders?.enabled === true;
  const trustedHeaderProvider = trustedHeaders?.provider === "generic" ? "generic" : "cloudflare-access";

  if (managedProvider === "tailscale" && publicUrl) {
    return {
      publicUrl,
      connectUrl: publicUrl,
      shareable: true,
      mode: "private-network",
      title: "Private remote URL ready",
      description: "Share this private URL only with operators who are already authenticated to your Tailscale network.",
      warnings: [],
      nextSteps: [],
    };
  }

  if (verifiedCloudflareAccess && publicUrl) {
    return {
      publicUrl,
      connectUrl: publicUrl,
      shareable: true,
      mode: "cloudflare-access",
      title: "Remote URL is protected by Cloudflare Access",
      description: "Share the protected dashboard URL. Conductor expects Cloudflare Access to verify identity before requests reach the app.",
      warnings: [],
      nextSteps: [],
    };
  }

  if (!publicUrl) {
    if (trustedHeaderEnabled && trustedHeaderProvider === "cloudflare-access") {
      return {
        publicUrl: null,
        connectUrl: null,
        shareable: false,
        mode: "misconfigured",
        title: "Cloudflare Access needs a verified public URL",
        description: "Conductor will only show an enterprise remote URL after Cloudflare Access is fully configured and a stable external dashboard URL is known.",
        warnings: [],
        nextSteps: [
          "Finish the Cloudflare Access application setup with a team domain and audience.",
          "Set `CONDUCTOR_PUBLIC_DASHBOARD_URL` to your protected dashboard URL, or open Conductor through that URL once so it can be observed safely.",
        ],
      };
    }

    if (preferredProvider === "tailscale") {
      return {
        publicUrl: null,
        connectUrl: null,
        shareable: false,
        mode: "enterprise-only",
        title: "Enterprise-only remote access is active",
        description: preferredProviderConnected
          ? "This instance is ready for a private VPN-style remote link. Enable the managed private link to publish the private URL."
          : "This instance is ready for a private VPN-style remote link. Enable the managed private link after Tailscale is installed and signed in.",
        warnings: [],
        nextSteps: preferredProviderConnected
          ? [
              "Enable the private link from Settings.",
              "Share the resulting private HTTPS URL only with operators who are already on your tailnet.",
            ]
          : [
              "Install and sign in to Tailscale on this machine, then enable the private link from Settings.",
              "Share the resulting private HTTPS URL only with operators who are already on your tailnet.",
            ],
      };
    }

    if (verifiedCloudflareAccess) {
      return {
        publicUrl: null,
        connectUrl: null,
        shareable: false,
        mode: "misconfigured",
        title: "Cloudflare Access needs a verified public URL",
        description: "Conductor is configured for enterprise edge identity, but it still needs the protected external dashboard URL before it can publish a remote link.",
        warnings: [],
        nextSteps: [
          "Set `CONDUCTOR_PUBLIC_DASHBOARD_URL` to the protected external URL once Cloudflare Access is live.",
        ],
      };
    }

    return {
      publicUrl: null,
      connectUrl: null,
      shareable: false,
      mode: "enterprise-only",
      title: "Enterprise-only remote access is active",
      description: "Conductor no longer publishes public share links. Use the private Tailscale link or a protected Cloudflare Access URL instead.",
      warnings: [],
      nextSteps: [
        "Install and sign in to Tailscale on this machine, then enable the private link from Settings.",
        "Or configure verified Cloudflare Access and set `CONDUCTOR_PUBLIC_DASHBOARD_URL` to the protected external URL.",
      ],
    };
  }

  if (trustedHeaderEnabled) {
    return {
      publicUrl,
      connectUrl: null,
      shareable: false,
      mode: "generic-header",
      title: "Legacy trusted-header mode is blocked",
      description: "Conductor no longer treats generic header passthrough as enterprise-safe remote access.",
      warnings: [
        "Switch to verified Cloudflare Access. Generic header passthrough is easier to spoof and is not offered as a shareable remote path.",
      ],
      nextSteps: [
        "Disable the legacy proxy-header mode.",
        "Configure verified Cloudflare Access with a team domain and audience, then share the protected external URL instead.",
      ],
    };
  }

  if (clerkConfigured) {
    return {
      publicUrl,
      connectUrl: publicUrl,
      shareable: true,
      mode: "clerk",
      title: "Remote URL is protected by Clerk",
      description: "Share the public dashboard URL. Recipients still have to sign in before they can access the instance.",
      warnings: [],
      nextSteps: [],
    };
  }

  if (access?.requireAuth) {
    return {
      publicUrl,
      connectUrl: null,
      shareable: false,
      mode: "misconfigured",
      title: "Authentication is required, but no remote provider is active",
      description: "Conductor found a public URL, but there is no private-network provider, Clerk setup, or verified edge identity provider to complete the sign-in.",
      warnings: [],
      nextSteps: [
        "Configure Tailscale, Clerk, or verified Cloudflare Access before sharing this instance remotely.",
      ],
    };
  }

  return {
    publicUrl,
    connectUrl: null,
    shareable: false,
    mode: "unsafe-public",
    title: "Public URL found, but auth is missing",
    description: "Conductor will not suggest a shareable remote-control URL until the dashboard is protected by private-network access, Clerk, or verified Cloudflare Access.",
    warnings: [
      "A bare public dashboard URL is not treated as safe remote access.",
    ],
    nextSteps: [
      "Configure Tailscale, Clerk, or verified Cloudflare Access before exposing this dashboard.",
    ],
  };
}
