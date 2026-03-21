import { sanitizeRedirectTarget } from "@/lib/remoteAuth";

const DEFAULT_POST_SIGN_IN_REDIRECT = "/";

function resolveRelativeRedirectTarget(
  candidate: string | null | undefined,
  requestBaseUrl?: string | null,
): string {
  if (!candidate) {
    return DEFAULT_POST_SIGN_IN_REDIRECT;
  }

  const nextPath = sanitizeRedirectTarget(candidate);
  if (nextPath !== DEFAULT_POST_SIGN_IN_REDIRECT || candidate.trim() === DEFAULT_POST_SIGN_IN_REDIRECT) {
    return nextPath;
  }

  const normalizedBaseUrl = (requestBaseUrl ?? "").trim();
  if (!normalizedBaseUrl) {
    return DEFAULT_POST_SIGN_IN_REDIRECT;
  }

  try {
    const targetUrl = new URL(candidate, normalizedBaseUrl);
    const baseUrl = new URL(normalizedBaseUrl);
    if (targetUrl.origin !== baseUrl.origin) {
      return DEFAULT_POST_SIGN_IN_REDIRECT;
    }

    return sanitizeRedirectTarget(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);
  } catch {
    return DEFAULT_POST_SIGN_IN_REDIRECT;
  }
}

export function resolvePostSignInRedirectTarget(
  candidate: string | null | undefined,
  requestBaseUrl?: string | null,
): string {
  const nextPath = resolveRelativeRedirectTarget(candidate, requestBaseUrl);

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

export function buildSignInPath(redirectTarget?: string | null): string {
  const nextPath = resolvePostSignInRedirectTarget(redirectTarget);
  if (nextPath === DEFAULT_POST_SIGN_IN_REDIRECT) {
    return "/sign-in";
  }

  const params = new URLSearchParams({ redirect_url: nextPath });
  return `/sign-in?${params.toString()}`;
}

export function buildHostedSignInPath(redirectTarget?: string | null): string {
  const nextPath = resolvePostSignInRedirectTarget(redirectTarget);
  if (nextPath === DEFAULT_POST_SIGN_IN_REDIRECT) {
    return "/sign-in/hosted";
  }

  const params = new URLSearchParams({ redirect_url: nextPath });
  return `/sign-in/hosted?${params.toString()}`;
}

export function buildHostedSignInRedirectUrl(
  signInUrl: string | null | undefined,
  requestBaseUrl: string | null | undefined,
  redirectTarget?: string | null,
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
      resolvePostSignInRedirectTarget(redirectTarget),
      normalizedBaseUrl,
    );
    destinationUrl.searchParams.set("redirect_url", absoluteReturnUrl.toString());
    return destinationUrl.toString();
  } catch {
    return null;
  }
}
