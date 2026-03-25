import type { AgentModelAccess } from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  extractQuotedChoices,
  formatGenericModelLabel,
  readCommandHelp,
} from "./helpers";

export async function buildCursorRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const help = await readCommandHelp(["cursor-agent", "cursor-cli", "cursor"]);
  if (!help) {
    return null;
  }

  const modelIds = extractQuotedChoices(help, "--model <model>");
  if (modelIds.length === 0) {
    return null;
  }

  const models = modelIds.map((modelId) => ({
    id: modelId,
    label: formatGenericModelLabel(modelId),
    description: `Model exposed by the local Cursor Agent CLI (${modelId}).`,
    access: ["default"] as AgentModelAccess[],
  }));
  const defaultModel = modelIds.includes("auto")
    ? "auto"
    : modelIds[0] ?? null;

  return buildDefaultAccessRuntimeCatalog("cursor-cli", models, {
    customModelPlaceholder: defaultModel,
    defaultModel,
  });
}
