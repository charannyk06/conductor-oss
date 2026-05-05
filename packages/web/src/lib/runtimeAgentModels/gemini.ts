import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  collectRegexMatchesFromRecentFiles,
  toRuntimeModelOption,
  uniqueModelOptions,
} from "./helpers";

const STALE_GEMINI_FLASH_MODEL_ID = "gemini-3.1-flash-preview";
const GEMINI_FLASH_MODEL_ID = "gemini-3-flash-preview";

function normalizeGeminiRuntimeModelId(model: string): string | null {
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === STALE_GEMINI_FLASH_MODEL_ID) {
    return GEMINI_FLASH_MODEL_ID;
  }
  return trimmed;
}

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

export function parseGeminiRuntimeModelCatalog(models: string[]): RuntimeAgentModelCatalog | null {
  const normalizedModels = models.flatMap((model) => {
    const normalized = normalizeGeminiRuntimeModelId(model);
    return normalized ? [normalized] : [];
  });

  if (normalizedModels.length === 0) {
    return null;
  }

  const runtimeModels = uniqueModelOptions(normalizedModels.map((model) => toRuntimeModelOption(
    model,
    `Model discovered from the local Gemini CLI installation (${model}).`,
    ["oauth", "api"],
    formatGeminiModelLabel,
  )));
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
  };
}

export async function buildGeminiRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const models = await collectRegexMatchesFromRecentFiles(
    join(homedir(), ".gemini"),
    /"(?:model|modelVersion)"\s*:\s*"([^"]+)"/g,
    { extensions: [".json", ".jsonl"], filenamePattern: /\.(json|jsonl)$/i, maxDepth: 4, maxFiles: 12, maxDirectories: 48 },
  );

  return parseGeminiRuntimeModelCatalog(models);
}
