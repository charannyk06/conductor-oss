import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  readRemoteAccessRuntimeState,
  type RemoteAccessRuntimeState,
  writeRemoteAccessRuntimeState,
} from "./remoteAccessRuntime";

type AutoInstallMethod = "brew" | null;

export type ManagedRemoteAccessProvider = "tailscale" | null;

export type ManagedRemoteAccessStatus = {
  state: RemoteAccessRuntimeState | null;
  recommendedProvider: ManagedRemoteAccessProvider;
  installed: boolean;
  connected: boolean;
  canAutoInstall: boolean;
  autoInstallMethod: AutoInstallMethod;
};

type TailscaleSupport = {
  provider: "tailscale";
  tailscalePath: string | null;
  brewPath: string | null;
  installed: boolean;
  canAutoInstall: boolean;
  autoInstallMethod: AutoInstallMethod;
  connected: boolean;
  dnsName: string | null;
  connectionError: string | null;
};

const globalForRemoteAccessManager = globalThis as typeof globalThis & {
  _conductorRemoteAccessLock?: Promise<void>;
};

function resolveMacAppCommand(command: string): string | null {
  if (process.platform !== "darwin" || command !== "tailscale") {
    return null;
  }

  const homeApplications = process.env.HOME?.trim()
    ? `${process.env.HOME.trim()}/Applications/Tailscale.app/Contents/MacOS/Tailscale`
    : null;
  const candidates = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    homeApplications,
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCommandPath(command: string): string | null {
  const result = process.platform === "win32"
    ? spawnSync("where", [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    : spawnSync("sh", ["-lc", `command -v ${command}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
  if (result.status === 0) {
    const resolved = result.stdout.trim().split(/\n+/g).pop()?.trim() ?? "";
    if (resolved.length > 0) {
      return resolved;
    }
  }

  return resolveMacAppCommand(command);
}

function resolveBrewPath(): string | null {
  return resolveCommandPath("brew");
}

function normalizeDnsName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\.+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function readTailscaleStatus(tailscalePath: string): {
  connected: boolean;
  dnsName: string | null;
  error: string | null;
} {
  const result = spawnSync(tailscalePath, ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "Tailscale is installed but not signed in on this machine.";
    return {
      connected: false,
      dnsName: null,
      error: message,
    };
  }

  try {
    const payload = JSON.parse(result.stdout) as {
      Self?: {
        DNSName?: unknown;
      } | null;
    };
    const dnsName = normalizeDnsName(payload.Self?.DNSName);
    return {
      connected: Boolean(dnsName),
      dnsName,
      error: dnsName ? null : "Tailscale is installed but not signed in on this machine.",
    };
  } catch {
    return {
      connected: false,
      dnsName: null,
      error: "Tailscale returned an unreadable status payload.",
    };
  }
}

function getTailscaleSupport(brewPath = resolveBrewPath()): TailscaleSupport {
  const tailscalePath = resolveCommandPath("tailscale");
  const status = tailscalePath
    ? readTailscaleStatus(tailscalePath)
    : {
        connected: false,
        dnsName: null,
        error: null,
      };

  return {
    provider: "tailscale",
    tailscalePath,
    brewPath,
    installed: Boolean(tailscalePath),
    canAutoInstall: !tailscalePath && Boolean(brewPath),
    autoInstallMethod: brewPath ? "brew" : null,
    connected: status.connected,
    dnsName: status.dnsName,
    connectionError: status.error,
  };
}

function resolvePreferredProvider(
  state: RemoteAccessRuntimeState | null,
  tailscaleSupport: TailscaleSupport,
): ManagedRemoteAccessProvider {
  if (state?.provider === "tailscale") return "tailscale";
  if (tailscaleSupport.installed || tailscaleSupport.canAutoInstall) return "tailscale";
  return null;
}

function resolveLocalDashboardUrl(): string {
  const rawPort = process.env.PORT?.trim();
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
    ? parsedPort
    : 3000;
  const configuredHost = process.env.HOSTNAME?.trim().toLowerCase() || "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::"
    ? "127.0.0.1"
    : configuredHost;
  return `http://${host}:${port}`;
}

function resolveLocalBackendUrl(): string | null {
  const explicit = process.env.CONDUCTOR_BACKEND_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.toString();
      }
    } catch {
      // Ignore invalid backend URLs and fall back to env port.
    }
  }

  const rawPort = process.env.CONDUCTOR_BACKEND_PORT?.trim();
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null;
  }

  return `http://127.0.0.1:${parsedPort}`;
}

function parseServePort(url: string | null): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const port = Number.parseInt(parsed.port, 10);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function buildTailscaleUrl(dnsName: string): string {
  return `https://${dnsName}`;
}

function parseDashboardPort(localUrl: string): string {
  try {
    const url = new URL(localUrl);
    return url.port || "80";
  } catch {
    return "3000";
  }
}

function ensureTailscaleServedEndpoints(
  tailscalePath: string,
  localUrl: string,
  localBackendUrl: string | null,
): void {
  const port = parseDashboardPort(localUrl);
  const serve = spawnSync(tailscalePath, ["serve", "--bg", port], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (serve.status !== 0) {
    throw new Error(serve.stderr.trim() || serve.stdout.trim() || "Tailscale Serve could not publish a private HTTPS URL.");
  }

  const backendPort = parseServePort(localBackendUrl);
  if (!backendPort) {
    return;
  }

  const backendServe = spawnSync(
    tailscalePath,
    ["serve", "--bg", "--https", String(backendPort), String(backendPort)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    },
  );
  if (backendServe.status !== 0) {
    throw new Error(
      backendServe.stderr.trim()
        || backendServe.stdout.trim()
        || "Tailscale could not publish the private backend endpoint.",
    );
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(pid: number | null): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) return;
    await wait(150);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

function refreshTailscaleState(
  state: RemoteAccessRuntimeState,
  localUrl: string,
): RemoteAccessRuntimeState | null {
  const support = getTailscaleSupport(resolveBrewPath());
  if (!support.installed) {
    return writeRemoteAccessRuntimeState({
      status: "error",
      provider: "tailscale",
      publicUrl: null,
      localUrl: state.localUrl ?? localUrl,
      accessToken: null,
      sessionSecret: null,
      tunnelPid: null,
      logPath: null,
      lastError: "Tailscale is no longer installed on this machine.",
      startedAt: state.startedAt ?? null,
    });
  }

  if (!support.connected || !support.dnsName) {
    return writeRemoteAccessRuntimeState({
      status: "error",
      provider: "tailscale",
      publicUrl: null,
      localUrl: state.localUrl ?? localUrl,
      accessToken: null,
      sessionSecret: null,
      tunnelPid: null,
      logPath: null,
      lastError: support.connectionError ?? "Tailscale is installed but not signed in on this machine.",
      startedAt: state.startedAt ?? null,
    });
  }

  try {
    const tailscalePath = support.tailscalePath;
    if (!tailscalePath) {
      throw new Error("Tailscale is installed but the executable path could not be resolved.");
    }
    ensureTailscaleServedEndpoints(
      tailscalePath,
      localUrl,
      resolveLocalBackendUrl(),
    );
  } catch (error) {
    return writeRemoteAccessRuntimeState({
      status: "error",
      provider: "tailscale",
      publicUrl: null,
      localUrl: state.localUrl ?? localUrl,
      accessToken: null,
      sessionSecret: null,
      tunnelPid: null,
      logPath: null,
      lastError: error instanceof Error ? error.message : "Tailscale could not refresh the private remote endpoints.",
      startedAt: state.startedAt ?? null,
    });
  }

  const publicUrl = buildTailscaleUrl(support.dnsName);
  if (
    state.status !== "ready"
    || state.publicUrl !== publicUrl
    || state.localUrl !== localUrl
    || state.accessToken
    || state.sessionSecret
  ) {
    return writeRemoteAccessRuntimeState({
      status: "ready",
      provider: "tailscale",
      publicUrl,
      localUrl,
      accessToken: null,
      sessionSecret: null,
      tunnelPid: null,
      logPath: null,
      lastError: null,
      startedAt: state.startedAt ?? new Date().toISOString(),
    });
  }

  return state;
}

async function reconcileRemoteAccessState(): Promise<RemoteAccessRuntimeState | null> {
  const state = readRemoteAccessRuntimeState();
  if (!state) return null;
  if (state.status === "disabled") return state;

  const localUrl = resolveLocalDashboardUrl();
  if (state.provider === "tailscale") {
    return refreshTailscaleState(state, localUrl);
  }

  if (state.tunnelPid) {
    await terminateProcess(state.tunnelPid);
  }

  return writeRemoteAccessRuntimeState({
    status: "disabled",
    provider: null,
    publicUrl: null,
    localUrl: state.localUrl ?? localUrl,
    accessToken: null,
    sessionSecret: null,
    tunnelPid: null,
    logPath: null,
    lastError: "Legacy public-share remote access has been removed. Re-enable remote access to use the private link.",
    startedAt: null,
  });
}

async function withRemoteAccessLock<T>(operation: () => Promise<T>): Promise<T> {
  while (globalForRemoteAccessManager._conductorRemoteAccessLock) {
    await globalForRemoteAccessManager._conductorRemoteAccessLock;
  }

  let releaseLock!: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  globalForRemoteAccessManager._conductorRemoteAccessLock = lock;

  try {
    return await operation();
  } finally {
    if (globalForRemoteAccessManager._conductorRemoteAccessLock === lock) {
      globalForRemoteAccessManager._conductorRemoteAccessLock = undefined;
    }
    releaseLock();
  }
}

function buildStatus(state: RemoteAccessRuntimeState | null): ManagedRemoteAccessStatus {
  const brewPath = resolveBrewPath();
  const tailscaleSupport = getTailscaleSupport(brewPath);
  const recommendedProvider = resolvePreferredProvider(state, tailscaleSupport);

  return {
    state,
    recommendedProvider,
    installed: tailscaleSupport.installed,
    connected: tailscaleSupport.connected,
    canAutoInstall: tailscaleSupport.canAutoInstall,
    autoInstallMethod: tailscaleSupport.autoInstallMethod,
  };
}

function installTailscale(brewPath: string | null): void {
  if (!brewPath) {
    throw new Error("Tailscale is not installed and automatic installation is not available.");
  }

  const args = process.platform === "darwin"
    ? ["install", "--cask", "tailscale"]
    : ["install", "tailscale"];
  const result = spawnSync(brewPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error("Homebrew could not install Tailscale.");
  }
}

function ensureTailscaleConnected(support: TailscaleSupport): TailscaleSupport {
  if (!support.tailscalePath) {
    throw new Error("Tailscale is not installed on this machine.");
  }
  if (support.connected && support.dnsName) {
    return support;
  }

  const authKey = process.env.CONDUCTOR_TAILSCALE_AUTH_KEY?.trim() ?? "";
  if (!authKey) {
    throw new Error(
      support.connectionError
      || "Tailscale is installed but not signed in. Sign in once with `tailscale up` or the Tailscale app, or set CONDUCTOR_TAILSCALE_AUTH_KEY for automatic setup.",
    );
  }

  const result = spawnSync(support.tailscalePath, ["up", `--auth-key=${authKey}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Tailscale could not complete automatic sign-in.");
  }

  const refreshed = getTailscaleSupport(support.brewPath);
  if (!refreshed.connected || !refreshed.dnsName) {
    throw new Error(
      refreshed.connectionError
      || "Tailscale sign-in completed, but the private network URL is still unavailable.",
    );
  }
  return refreshed;
}

function enableTailscalePrivateLink(
  currentState: RemoteAccessRuntimeState | null,
  localUrl: string,
): RemoteAccessRuntimeState | null {
  const brewPath = resolveBrewPath();
  let support = getTailscaleSupport(brewPath);
  if (!support.installed) {
    if (!support.canAutoInstall) {
      throw new Error("Tailscale is not installed. Install it once, or set up Cloudflare Access for a protected public link.");
    }
    installTailscale(support.brewPath);
    support = getTailscaleSupport(brewPath);
  }

  support = ensureTailscaleConnected(support);
  if (!support.tailscalePath || !support.dnsName) {
    throw new Error("Tailscale did not expose a private DNS name for this machine.");
  }
  ensureTailscaleServedEndpoints(
    support.tailscalePath,
    localUrl,
    resolveLocalBackendUrl(),
  );

  return writeRemoteAccessRuntimeState({
    status: "ready",
    provider: "tailscale",
    publicUrl: buildTailscaleUrl(support.dnsName),
    localUrl,
    accessToken: null,
    sessionSecret: null,
    tunnelPid: null,
    logPath: null,
    lastError: null,
    startedAt: currentState?.startedAt ?? new Date().toISOString(),
  });
}

export async function getManagedRemoteAccessStatus(): Promise<ManagedRemoteAccessStatus> {
  const state = await reconcileRemoteAccessState();
  return buildStatus(state);
}

export async function enableManagedRemoteAccess(): Promise<ManagedRemoteAccessStatus> {
  return withRemoteAccessLock(async () => {
    const localUrl = resolveLocalDashboardUrl();
    const currentState = await reconcileRemoteAccessState();

    if (currentState?.status === "ready" && currentState.provider === "tailscale" && currentState.publicUrl) {
      return buildStatus(currentState);
    }

    return buildStatus(enableTailscalePrivateLink(currentState, localUrl));
  });
}

export async function rotateManagedRemoteAccess(): Promise<ManagedRemoteAccessStatus> {
  void (await reconcileRemoteAccessState());
  throw new Error("Public share links have been removed. Private network access is controlled by Tailscale identity and ACLs.");
}

export async function disableManagedRemoteAccess(): Promise<ManagedRemoteAccessStatus> {
  return withRemoteAccessLock(async () => {
    const currentState = await reconcileRemoteAccessState();

    if (currentState?.provider === "tailscale") {
      const tailscaleSupport = getTailscaleSupport(resolveBrewPath());
      if (tailscaleSupport.tailscalePath) {
        const reset = spawnSync(tailscaleSupport.tailscalePath, ["serve", "reset"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            NO_COLOR: "1",
          },
        });
        if (reset.status !== 0) {
          throw new Error(reset.stderr.trim() || reset.stdout.trim() || "Tailscale private link could not be disabled.");
        }
      }
    }

    const disabledState = writeRemoteAccessRuntimeState({
      status: "disabled",
      provider: null,
      publicUrl: null,
      localUrl: currentState?.localUrl ?? resolveLocalDashboardUrl(),
      accessToken: null,
      sessionSecret: null,
      tunnelPid: null,
      logPath: null,
      lastError: null,
      startedAt: null,
    });
    return buildStatus(disabledState);
  });
}
