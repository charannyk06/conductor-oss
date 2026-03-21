import { sanitizeRedirectTarget } from "@/lib/remoteAuth";

const DEFAULT_POST_SIGN_IN_REDIRECT = "/";
const DEFAULT_PAIRED_DEVICE_POST_SIGN_IN_REDIRECT = "/bridge/connect";

function normalizeDefaultRedirectTarget(candidate?: string | null): string {
  const nextPath = sanitizeRedirectTarget(candidate ?? DEFAULT_POST_SIGN_IN_REDIRECT);

  if (
    nextPath === "/sign-in"
    || nextPath === "/sign-in/"
    || nextPath.startsWith("/sign-in?")
    || nextPath.startsWith("/sign-in/")
  ) {
    return DEFAULT_POST_SIGN_IN_REDIRECT;
  }

  return nextPath;
}

export function getDefaultPostSignInRedirectTarget(pairedDeviceRequired = false): string {
  return pairedDeviceRequired
    ? DEFAULT_PAIRED_DEVICE_POST_SIGN_IN_REDIRECT
    : DEFAULT_POST_SIGN_IN_REDIRECT;
}

function resolveRelativeRedirectTarget(
  candidate: string | null | undefined,
  requestBaseUrl?: string | null,
  defaultRedirectTarget?: string | null,
): string {
  const resolvedDefaultRedirectTarget = normalizeDefaultRedirectTarget(defaultRedirectTarget);
  if (!candidate) {
    return resolvedDefaultRedirectTarget;
  }

  const nextPath = sanitizeRedirectTarget(candidate);
  if (nextPath !== DEFAULT_POST_SIGN_IN_REDIRECT || candidate.trim() === DEFAULT_POST_SIGN_IN_REDIRECT) {
    return nextPath;
  }

  const normalizedBaseUrl = (requestBaseUrl ?? "").trim();
  if (!normalizedBaseUrl) {
    return resolvedDefaultRedirectTarget;
  }

  try {
    const targetUrl = new URL(candidate, normalizedBaseUrl);
    const baseUrl = new URL(normalizedBaseUrl);
    if (targetUrl.origin !== baseUrl.origin) {
      return resolvedDefaultRedirectTarget;
    }

    return sanitizeRedirectTarget(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);
  } catch {
    return resolvedDefaultRedirectTarget;
  }
}

export function resolvePostSignInRedirectTarget(
  candidate: string | null | undefined,
  requestBaseUrl?: string | null,
  defaultRedirectTarget?: string | null,
): string {
  const resolvedDefaultRedirectTarget = normalizeDefaultRedirectTarget(defaultRedirectTarget);
  const nextPath = resolveRelativeRedirectTarget(candidate, requestBaseUrl, resolvedDefaultRedirectTarget);

  if (
    nextPath === "/sign-in"
    || nextPath === "/sign-in/"
    || nextPath.startsWith("/sign-in?")
    || nextPath.startsWith("/sign-in/")
  ) {
    return resolvedDefaultRedirectTarget;
  }

  return nextPath;
}

export function buildSignInPath(
  redirectTarget?: string | null,
  defaultRedirectTarget?: string | null,
): string {
  const normalizedDefaultRedirectTarget = normalizeDefaultRedirectTarget(defaultRedirectTarget);
  const nextPath = resolvePostSignInRedirectTarget(redirectTarget, undefined, normalizedDefaultRedirectTarget);
  if (nextPath === normalizedDefaultRedirectTarget && nextPath === DEFAULT_POST_SIGN_IN_REDIRECT) {
    return "/sign-in";
  }

  const params = new URLSearchParams({ redirect_url: nextPath });
  return `/sign-in?${params.toString()}`;
}

export function buildHostedSignInPath(
  redirectTarget?: string | null,
  defaultRedirectTarget?: string | null,
): string {
  const normalizedDefaultRedirectTarget = normalizeDefaultRedirectTarget(defaultRedirectTarget);
  const nextPath = resolvePostSignInRedirectTarget(redirectTarget, undefined, normalizedDefaultRedirectTarget);
  if (nextPath === normalizedDefaultRedirectTarget && nextPath === DEFAULT_POST_SIGN_IN_REDIRECT) {
    return "/sign-in/hosted";
  }

  const params = new URLSearchParams({ redirect_url: nextPath });
  return `/sign-in/hosted?${params.toString()}`;
}

export function buildHostedSignInRedirectUrl(
  signInUrl: string | null | undefined,
  requestBaseUrl: string | null | undefined,
  redirectTarget?: string | null,
  defaultRedirectTarget?: string | null,
): string | null {
  const normalizedSignInUrl = (signInUrl ?? "").trim();
  const normalizedBaseUrl = (requestBaseUrl ?? "").trim();
  if (!normalizedSignInUrl || !normalizedBaseUrl) {
    return null;
  }

  try {
    const destinationUrl = new URL(normalizedSignInUrl, normalizedBaseUrl);
    const localSignInUrl = new URL("/sign-in", normalizedBaseUrl);

    if (
      destinationUrl.origin === localSignInUrl.origin
      && destinationUrl.pathname === localSignInUrl.pathname
    ) {
      return null;
    }

    const absoluteReturnUrl = new URL(
      resolvePostSignInRedirectTarget(redirectTarget, normalizedBaseUrl, defaultRedirectTarget),
      normalizedBaseUrl,
    );
    destinationUrl.searchParams.set("redirect_url", absoluteReturnUrl.toString());
    return destinationUrl.toString();
  } catch {
    return null;
  }
}
