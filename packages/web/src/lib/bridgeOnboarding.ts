const DEFAULT_UNIX_INSTALL_SCRIPT_PATH = "/bridge/install.sh";
const DEFAULT_WINDOWS_INSTALL_SCRIPT_PATH = "/bridge/install.ps1";

export type BridgeInstallPlatform = "unix" | "windows";

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function formatCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powerShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+\\-]+$/.test(value)) {
    return value;
  }

  return powerShellQuote(value);
}

function formatPowerShellCommand(invocation: string, args: string[]): string {
  return [invocation, ...args.map(powerShellArg)].join(" ");
}

function buildWindowsBridgeInvocation(): string {
  return "& (Join-Path $HOME '.conductor\\bin\\conductor-bridge.exe')";
}

function buildBridgeCliCommand(
  args: string[],
  platform: BridgeInstallPlatform = "unix",
): string {
  if (platform === "windows") {
    return formatPowerShellCommand(buildWindowsBridgeInvocation(), args);
  }

  return formatCommand(["conductor-bridge", ...args]);
}

export function resolveBridgeInstallPlatform(os: string | null | undefined): BridgeInstallPlatform {
  const normalized = os?.trim().toLowerCase() ?? "";
  return normalized.startsWith("windows") ? "windows" : "unix";
}

export function buildBridgeInstallScriptUrl(
  baseUrl: string,
  platform: BridgeInstallPlatform = "unix",
): string {
  return new URL(
    platform === "windows" ? DEFAULT_WINDOWS_INSTALL_SCRIPT_PATH : DEFAULT_UNIX_INSTALL_SCRIPT_PATH,
    baseUrl,
  ).toString();
}

export function buildBridgeRepairHref(deviceId: string): string {
  return `/bridge/connect?device=${encodeURIComponent(deviceId)}#bridge-setup`;
}

export function buildBridgeInstallCommand(
  installScriptUrl: string,
  platform: BridgeInstallPlatform = "unix",
): string {
  if (platform === "windows") {
    return `& ([scriptblock]::Create((Invoke-RestMethod -Uri ${powerShellQuote(installScriptUrl)})))`;
  }

  return `curl -fsSL ${shellQuote(installScriptUrl)} | sh`;
}

export function buildBridgeBootstrapConnectCommand(
  installScriptUrl: string,
  dashboardUrl: string,
  relayUrl?: string | null,
  platform: BridgeInstallPlatform = "unix",
): string {
  if (platform === "windows") {
    const parts = [
      `& ([scriptblock]::Create((Invoke-RestMethod -Uri ${powerShellQuote(installScriptUrl)})))`,
      "-Connect",
      "-DashboardUrl",
      powerShellQuote(dashboardUrl),
    ];

    if (relayUrl?.trim()) {
      parts.push("-RelayUrl", powerShellQuote(relayUrl.trim()));
    }

    return parts.join(" ");
  }

  const parts = [
    "sh",
    "-s",
    "--",
    "--connect",
    "--dashboard-url",
    dashboardUrl,
  ];

  if (relayUrl?.trim()) {
    parts.push("--relay-url", relayUrl.trim());
  }

  return `curl -fsSL ${shellQuote(installScriptUrl)} | ${formatCommand(parts)}`;
}

export function buildBridgeConnectCommand(
  dashboardUrl: string,
  relayUrl?: string | null,
  platform: BridgeInstallPlatform = "unix",
): string {
  const parts = ["connect", "--dashboard-url", dashboardUrl];
  if (relayUrl?.trim()) {
    parts.push("--relay-url", relayUrl.trim());
  }
  return buildBridgeCliCommand(parts, platform);
}

export function buildBridgeManualPairCommand(
  pairingCode: string | null | undefined,
  relayUrl?: string | null,
  platform: BridgeInstallPlatform = "unix",
): string {
  const resolvedPairingCode = pairingCode?.trim() || "ABC123";
  const pairParts = ["pair", "--code", resolvedPairingCode];
  const daemonParts = ["daemon"];

  if (relayUrl?.trim()) {
    pairParts.push("--relay-url", relayUrl.trim());
    daemonParts.push("--relay-url", relayUrl.trim());
  }

  return `${buildBridgeCliCommand(pairParts, platform)}\n${buildBridgeCliCommand(daemonParts, platform)}`;
}
