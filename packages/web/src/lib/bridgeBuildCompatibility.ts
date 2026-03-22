export type LegacyBridgeAction = "repair" | "restart" | "update";

export function isLegacyBridgeBuildErrorMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }

  return normalized.includes("127.0.0.1:4749")
    || normalized.includes("older bridge build")
    || normalized.includes("one-time local bridge upgrade");
}

function legacyBridgeActionLabel(action: LegacyBridgeAction): string {
  switch (action) {
    case "repair":
      return "Repair bridge";
    case "restart":
      return "Restart service";
    case "update":
      return "Update Conductor";
  }
}

export function legacyBridgeBuildActionMessage(action: LegacyBridgeAction): string {
  return `This laptop needs a one-time local bridge upgrade before ${legacyBridgeActionLabel(action)} can run from the dashboard.`;
}

export function describeLegacyBridgeBuild(deviceName?: string | null): string {
  const subject = deviceName?.trim() || "This laptop";
  return `${subject} is still on an older bridge build, so Conductor cannot repair, restart, or update it remotely yet. Upgrade the bridge once on that laptop, then future fixes run from the dashboard.`;
}
