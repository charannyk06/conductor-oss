import { normalizeBridgeId } from "@/lib/bridgeSessionIds";

export function buildAllProjectsHref(bridgeId?: string | null): string {
  const normalizedBridgeId = normalizeBridgeId(bridgeId);
  if (!normalizedBridgeId) {
    return "/";
  }

  const params = new URLSearchParams();
  params.set("bridge", normalizedBridgeId);
  return `/?${params.toString()}`;
}
