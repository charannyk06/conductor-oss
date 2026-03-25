import { decodeBridgeSessionId, encodeBridgeSessionId, normalizeBridgeId } from "@/lib/bridgeSessionIds";

export function buildAllProjectsHref(bridgeId?: string | null): string {
  const normalizedBridgeId = normalizeBridgeId(bridgeId);
  if (!normalizedBridgeId) {
    return "/";
  }

  const params = new URLSearchParams();
  params.set("bridge", normalizedBridgeId);
  return `/?${params.toString()}`;
}

type BuildSessionHrefOptions = {
  bridgeId?: string | null;
  tab?: string | null;
};

export function buildSessionHref(
  sessionId: string,
  options: BuildSessionHrefOptions = {},
): string {
  const trimmedSessionId = sessionId.trim();
  const routeSessionId = decodeBridgeSessionId(trimmedSessionId)
    ? trimmedSessionId
    : (() => {
      const normalizedBridgeId = normalizeBridgeId(options.bridgeId);
      return normalizedBridgeId
        ? encodeBridgeSessionId(normalizedBridgeId, trimmedSessionId)
        : trimmedSessionId;
    })();

  const params = new URLSearchParams();
  const tab = options.tab?.trim();
  if (tab) {
    params.set("tab", tab);
  }

  const search = params.toString();
  const basePath = `/sessions/${encodeURIComponent(routeSessionId)}`;
  return search.length > 0 ? `${basePath}?${search}` : basePath;
}
