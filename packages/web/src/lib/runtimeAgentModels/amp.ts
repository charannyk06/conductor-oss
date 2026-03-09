import type { AgentModelAccess } from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  readCommandHelp,
  uniqueStringValues,
} from "./helpers";

function formatAmpModeLabel(mode: string): string {
  return `Amp ${mode.trim().charAt(0).toUpperCase()}${mode.trim().slice(1)}`;
}

export async function buildAmpRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const help = await readCommandHelp(["amp"]);
  if (!help) return null;

  const match = help.match(/Set the agent mode \(([^)]+)\)/i);
  const modes = uniqueStringValues(match?.[1]
    ? match[1]
      .split(",")
      .map((value) => value.trim().toLowerCase())
    : []);

  if (modes.length === 0) {
    return null;
  }

  const models = modes.map((mode) => ({
    id: mode,
    label: formatAmpModeLabel(mode),
    description: `Amp mode exposed by the local CLI (${mode}).`,
    access: ["default"] as AgentModelAccess[],
  }));
  const defaultMode = modes.includes("smart")
    ? "smart"
    : modes[0] ?? null;

  return buildDefaultAccessRuntimeCatalog("amp", models, {
    customModelPlaceholder: defaultMode,
    defaultModel: defaultMode,
  });
}
