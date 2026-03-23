type RawBridgeDevice = {
  device_id?: unknown;
  device_name?: unknown;
  hostname?: unknown;
  os?: unknown;
  arch?: unknown;
  connected?: unknown;
  last_status?: {
    hostname?: unknown;
    os?: unknown;
    connected?: unknown;
    version?: unknown;
  } | null;
};

export type BridgeDeviceRecord = {
  device_id: string;
  device_name: string;
  hostname: string;
  os: string;
  arch: string;
  connected: boolean;
  last_status: {
    hostname: string;
    os: string;
    connected: boolean;
    version: string | null;
  } | null;
};

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function normalizeBridgeDevice(raw: RawBridgeDevice): BridgeDeviceRecord {
  const hostname = asNonEmptyString(raw.hostname, "unknown-host");
  const os = asNonEmptyString(raw.os, "unknown-os");
  const arch = asNonEmptyString(raw.arch, "unknown-arch");
  const deviceId = asNonEmptyString(raw.device_id, hostname);

  return {
    device_id: deviceId,
    device_name: asNonEmptyString(raw.device_name, hostname),
    hostname,
    os,
    arch,
    connected: raw.connected === true,
    last_status: raw.last_status
      ? {
        hostname: asNonEmptyString(raw.last_status.hostname, hostname),
        os: asNonEmptyString(raw.last_status.os, os),
        connected: raw.last_status.connected === true,
        version: typeof raw.last_status.version === "string" && raw.last_status.version.trim().length > 0
          ? raw.last_status.version.trim()
          : null,
      }
      : null,
  };
}

export function formatBridgeVersionSuffix(version: string | null | undefined): string {
  const normalized = typeof version === "string" ? version.trim() : "";
  return normalized ? ` (build ${normalized})` : "";
}

export function normalizeBridgeDevices(value: unknown): BridgeDeviceRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is RawBridgeDevice => Boolean(entry) && typeof entry === "object")
    .map((entry) => normalizeBridgeDevice(entry));
}
