import { isBridgeRelayConfigurationError } from "@/lib/bridgeRelayErrors";

export const PREVIEW_MANAGER_USER_REQUIRED_ERROR = "Preview bridge auth requires a signed-in dashboard user.";
const BRIDGE_RELAY_USER_REQUIRED_ERROR = "Unable to resolve the dashboard user for the bridge relay.";

export function resolvePreviewManagerSessionId(sessionId: string, userId: string | null): string {
  const normalizedUserId = userId?.trim().toLowerCase();
  if (!normalizedUserId) {
    throw new Error(PREVIEW_MANAGER_USER_REQUIRED_ERROR);
  }
  return `${normalizedUserId}:${sessionId}`;
}

export function normalizePreviewBridgeSetupError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : "Failed to configure preview bridge";
  if (message === PREVIEW_MANAGER_USER_REQUIRED_ERROR) {
    return { status: 401, message };
  }
  if (message === BRIDGE_RELAY_USER_REQUIRED_ERROR) {
    return { status: 403, message };
  }
  if (isBridgeRelayConfigurationError(message)) {
    return { status: 503, message };
  }
  return { status: 500, message };
}
