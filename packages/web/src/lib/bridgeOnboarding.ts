const DEFAULT_INSTALL_SCRIPT_PATH = "/bridge/install.sh";

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function formatCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

export function buildBridgeInstallScriptUrl(baseUrl: string): string {
  return new URL(DEFAULT_INSTALL_SCRIPT_PATH, baseUrl).toString();
}

export function buildBridgeRepairHref(deviceId: string): string {
  return `/bridge/connect?device=${encodeURIComponent(deviceId)}#bridge-setup`;
}

export function buildBridgeInstallCommand(installScriptUrl: string): string {
  return `curl -fsSL ${shellQuote(installScriptUrl)} | sh`;
}

export function buildBridgeBootstrapConnectCommand(
  installScriptUrl: string,
  dashboardUrl: string,
  relayUrl?: string | null,
): string {
  const parts = [
    "curl",
    "-fsSL",
    installScriptUrl,
    "|",
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

  return parts.map((part) => (part === "|" ? part : shellQuote(part))).join(" ");
}

export function buildBridgeConnectCommand(
  dashboardUrl: string,
  relayUrl?: string | null,
): string {
  const parts = ["conductor-bridge", "connect", "--dashboard-url", dashboardUrl];
  if (relayUrl?.trim()) {
    parts.push("--relay-url", relayUrl.trim());
  }
  return formatCommand(parts);
}

export function buildBridgeManualPairCommand(
  pairingCode: string | null | undefined,
  relayUrl?: string | null,
): string {
  const resolvedPairingCode = pairingCode?.trim() || "ABC123";
  const pairParts = ["conductor-bridge", "pair", "--code", resolvedPairingCode];
  const daemonParts = ["conductor-bridge", "daemon"];

  if (relayUrl?.trim()) {
    pairParts.push("--relay-url", relayUrl.trim());
    daemonParts.push("--relay-url", relayUrl.trim());
  }

  return `${formatCommand(pairParts)}\n${formatCommand(daemonParts)}`;
}
