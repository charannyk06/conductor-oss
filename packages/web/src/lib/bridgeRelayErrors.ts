export const BRIDGE_RELAY_URL_NOT_CONFIGURED_ERROR = "Bridge relay URL is not configured";
export const BRIDGE_RELAY_SECRET_REQUIRED_ERROR = "RELAY_JWT_SECRET is required for bridge relay access";
export const BRIDGE_RELAY_SECRET_TOO_SHORT_ERROR = "RELAY_JWT_SECRET must contain at least 32 bytes";

export function isBridgeRelayConfigurationError(
  message: string | null | undefined,
): boolean {
  const normalized = message?.trim();
  return normalized === BRIDGE_RELAY_URL_NOT_CONFIGURED_ERROR
    || normalized === BRIDGE_RELAY_SECRET_REQUIRED_ERROR
    || normalized === BRIDGE_RELAY_SECRET_TOO_SHORT_ERROR;
}
