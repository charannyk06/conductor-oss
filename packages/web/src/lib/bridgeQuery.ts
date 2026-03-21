import { normalizeBridgeId } from "@/lib/bridgeSessionIds";

export function withBridgeQuery(pathname: string, bridgeId?: string | null): string {
  const normalizedBridgeId = normalizeBridgeId(bridgeId);
  if (!normalizedBridgeId) {
    return pathname;
  }

  const url = new URL(pathname, "http://127.0.0.1");
  url.searchParams.set("bridgeId", normalizedBridgeId);
  return `${url.pathname}${url.search}${url.hash}`;
}
