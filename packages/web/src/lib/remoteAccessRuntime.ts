import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RemoteAccessRuntimeStatus = "disabled" | "starting" | "ready" | "error";

export type RemoteAccessRuntimeState = {
  status: RemoteAccessRuntimeStatus;
  provider: "tailscale" | null;
  publicUrl: string | null;
  localUrl: string | null;
  accessToken: string | null;
  sessionSecret: string | null;
  tunnelPid: number | null;
  logPath: string | null;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

export function getRemoteAccessRuntimeStatePath(): string | null {
  const workspaceHint = process.env.CONDUCTOR_WORKSPACE?.trim() || process.env.CO_CONFIG_PATH?.trim();
  if (!workspaceHint) return null;

  const workspaceKey = createHash("sha256")
    .update(workspaceHint)
    .digest("hex");
  return join(homedir(), ".conductor", "runtime", "remote-access", `${workspaceKey}.json`);
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeState(value: unknown): RemoteAccessRuntimeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const status = raw.status;
  const normalizedStatus: RemoteAccessRuntimeStatus =
    status === "starting" || status === "ready" || status === "error" || status === "disabled"
      ? status
      : (asTrimmedString(raw.publicUrl) ? "ready" : "disabled");

  return {
    status: normalizedStatus,
    provider: raw.provider === "tailscale" ? raw.provider : null,
    publicUrl: asTrimmedString(raw.publicUrl),
    localUrl: asTrimmedString(raw.localUrl),
    accessToken: asTrimmedString(raw.accessToken),
    sessionSecret: asTrimmedString(raw.sessionSecret),
    tunnelPid: asNullableNumber(raw.tunnelPid),
    logPath: asTrimmedString(raw.logPath),
    lastError: asTrimmedString(raw.lastError),
    startedAt: asTrimmedString(raw.startedAt),
    updatedAt: asTrimmedString(raw.updatedAt),
  };
}

export function readRemoteAccessRuntimeState(): RemoteAccessRuntimeState | null {
  const statePath = getRemoteAccessRuntimeStatePath();
  if (!statePath) return null;

  try {
    return normalizeState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    return null;
  }
}

export function writeRemoteAccessRuntimeState(
  next: Partial<RemoteAccessRuntimeState> & Pick<RemoteAccessRuntimeState, "status">,
): RemoteAccessRuntimeState | null {
  const statePath = getRemoteAccessRuntimeStatePath();
  if (!statePath) return null;

  const current = readRemoteAccessRuntimeState();
  const pick = <Key extends keyof RemoteAccessRuntimeState>(key: Key): RemoteAccessRuntimeState[Key] => {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      return (next[key] ?? null) as RemoteAccessRuntimeState[Key];
    }
    return (current?.[key] ?? null) as RemoteAccessRuntimeState[Key];
  };

  const merged: RemoteAccessRuntimeState = {
    status: next.status,
    provider: pick("provider"),
    publicUrl: pick("publicUrl"),
    localUrl: pick("localUrl"),
    accessToken: pick("accessToken"),
    sessionSecret: pick("sessionSecret"),
    tunnelPid: pick("tunnelPid"),
    logPath: pick("logPath"),
    lastError: pick("lastError"),
    startedAt: pick("startedAt"),
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function clearRemoteAccessRuntimeState(): void {
  const statePath = getRemoteAccessRuntimeStatePath();
  if (!statePath || !existsSync(statePath)) return;
  rmSync(statePath, { force: true });
}
