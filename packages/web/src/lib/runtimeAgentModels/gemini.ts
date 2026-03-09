import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import type { SimpleAuthSettings } from "./types";
import {
  collectRegexMatchesFromRecentFiles,
  readJsonFileIfPresent,
  toRuntimeModelOption,
  uniqueModelOptions,
} from "./helpers";

function formatGeminiModelLabel(model: string): string {
  return model
    .trim()
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part[0]?.toUpperCase() + part.slice(1);
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export async function buildGeminiRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const settings = await readJsonFileIfPresent<SimpleAuthSettings>(join(homedir(), ".gemini", "settings.json"));
  const models = await collectRegexMatchesFromRecentFiles(
    join(homedir(), ".gemini"),
    /"(?:model|modelVersion)"\s*:\s*"([^"]+)"/g,
    { extensions: [".json", ".jsonl"], filenamePattern: /\.(json|jsonl)$/i, maxDepth: 4, maxFiles: 12, maxDirectories: 48 },
  );

  const discoveredModels = models.length > 0
    ? models
    : ["gemini-3.1-pro-preview", "gemini-3-flash-preview"];

  const runtimeModels = uniqueModelOptions(discoveredModels.map((model) => toRuntimeModelOption(
    model,
    models.length > 0
      ? `Model discovered from the local Gemini CLI installation (${model}).`
      : `Model exposed by the local Gemini CLI catalog (${model}).`,
    ["oauth", "api"],
    formatGeminiModelLabel,
  )));
  const selectedType = typeof settings?.security?.auth?.selectedType === "string"
    ? settings.security.auth.selectedType.trim().toLowerCase()
    : null;
  const defaultModel = runtimeModels[0]?.id ?? null;

  return {
    agent: "gemini",
    customModelPlaceholder: defaultModel ?? "",
    defaultModelByAccess: {
      ...(defaultModel ? { oauth: defaultModel, api: defaultModel } : {}),
    },
    modelsByAccess: {
      oauth: runtimeModels,
      api: runtimeModels,
    },
    defaultReasoningByAccess: {},
    ...(selectedType?.includes("oauth")
      ? { customModelPlaceholder: defaultModel ?? "" }
      : {}),
  };
}
