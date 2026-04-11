function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function normalizeBrowserBackendOrigin(rawOrigin: string | null | undefined, currentOrigin: string): string | null {
  const trimmed = rawOrigin?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const current = new URL(currentOrigin);
    const resolved = new URL(trimmed, currentOrigin);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    if (isLoopbackHostname(resolved.hostname) && !isLoopbackHostname(current.hostname)) {
      resolved.hostname = current.hostname;
      if (current.protocol === "https:" && resolved.protocol === "http:") {
        resolved.protocol = "https:";
      }
    }

    return resolved.origin;
  } catch {
    return null;
  }
}

export function resolveTerminalBrowserBackendOrigin(currentOrigin: string): string {
  const metaOrigin = typeof document === "undefined"
    ? null
    : document.querySelector<HTMLMetaElement>('meta[name="conductor-backend-url"]')?.content ?? null;

  return normalizeBrowserBackendOrigin(
    metaOrigin || process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL || null,
    currentOrigin,
  ) ?? currentOrigin;
}

function looksLikeNativeTerminalProxyPath(pathname: string): boolean {
  return pathname.startsWith("/api/sessions/") && pathname.includes("/terminal/ws");
}

export function resolveNativeTerminalWebSocketUrl(pathOrUrl: string, currentOrigin: string): string {
  if (pathOrUrl.startsWith("ws://") || pathOrUrl.startsWith("wss://")) {
    return pathOrUrl;
  }

  const baseOrigin = (() => {
    try {
      const candidate = new URL(pathOrUrl, currentOrigin);
      if (looksLikeNativeTerminalProxyPath(candidate.pathname)) {
        return resolveTerminalBrowserBackendOrigin(currentOrigin);
      }
    } catch {
      // Fall back to current origin below.
    }
    return currentOrigin;
  })();

  const origin = new URL(baseOrigin);
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const normalizedPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${origin.origin}${normalizedPath}`;
}
