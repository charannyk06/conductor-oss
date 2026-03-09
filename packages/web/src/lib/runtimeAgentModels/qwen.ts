import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  collectRegexMatchesFromRecentFiles,
  toRuntimeModelOption,
  uniqueModelOptions,
} from "./helpers";

function formatQwenModelLabel(model: string): string {
  return model
    .trim()
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export async function buildQwenRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const models = await collectRegexMatchesFromRecentFiles(
    join(homedir(), ".qwen"),
    /"(?:model|modelVersion)"\s*:\s*"([^"]+)"/g,
    { extensions: [".json", ".jsonl"], filenamePattern: /\.(json|jsonl)$/i, maxDepth: 5, maxFiles: 12, maxDirectories: 48 },
  );

  if (models.length === 0) {
    return null;
  }

  const runtimeModels = uniqueModelOptions(models.map((model) => toRuntimeModelOption(
    model,
    `Model discovered from the local Qwen Code installation (${model}).`,
    ["oauth", "api"],
    formatQwenModelLabel,
  )));
  const defaultModel = runtimeModels[0]?.id ?? null;

  return {
    agent: "qwen-code",
    customModelPlaceholder: defaultModel ?? "",
    defaultModelByAccess: {
      ...(defaultModel ? { oauth: defaultModel, api: defaultModel } : {}),
    },
    modelsByAccess: {
      oauth: runtimeModels,
      api: runtimeModels,
    },
    defaultReasoningByAccess: {},
  };
}
