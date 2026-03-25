export function shouldUseRemoteSessionTerminal(bridgeId?: string | null): boolean {
  return typeof bridgeId === "string" && bridgeId.trim().length > 0;
}
