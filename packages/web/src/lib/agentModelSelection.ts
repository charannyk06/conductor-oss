import {
  getAvailableAgentModels,
  getAvailableAgentReasoningEfforts,
  getAgentModelCatalog,
  getDefaultAgentModel,
  getDefaultAgentReasoningEffort,
  resolveAgentModelAccess,
  type AgentModelOption,
  type AgentReasoningOption,
  type ModelAccessPreferences,
} from "@conductor-oss/core/types";
import { normalizeAgentName } from "./agentUtils";
import {
  getRuntimeCatalogDefaultModelForAccess,
  getRuntimeCatalogDefaultReasoning,
  getRuntimeCatalogModelsForAccess,
  getRuntimeCatalogReasoningOptions,
  type RuntimeAgentModelCatalog,
} from "./runtimeAgentModelsShared";

export type ModelSelectionState = {
  catalogModel: string;
  customModel: string;
  reasoningEffort: string;
};

const STALE_GEMINI_FLASH_MODEL_ID = "gemini-3.1-flash-preview";
const GEMINI_FLASH_MODEL_ID = "gemini-3-flash-preview";

function usesBackendManagedModelConfig(agent: string): boolean {
  return normalizeAgentName(agent) === "openclaw";
}

function normalizePreferredModel(agent: string, model: string | null | undefined): string {
  const trimmed = model?.trim() ?? "";
  if (trimmed.length === 0) {
    return "";
  }

  const normalizedAgent = normalizeAgentName(agent);
  const normalizedModel = trimmed.toLowerCase();

  if (normalizedAgent === "gemini" && normalizedModel === STALE_GEMINI_FLASH_MODEL_ID) {
    return GEMINI_FLASH_MODEL_ID;
  }

  if (normalizedAgent === "cursor-cli") {
    if (normalizedModel === "gpt-5.3-codex") return "gpt-5";
    if (normalizedModel === "gpt-5.3-codex-fast") return "gpt-5-fast";
    if (normalizedModel === "gpt-5.3-codex-high") return "gpt-5-high";
    if (normalizedModel === "opus") return "opus-4.1";
  }

  if (normalizedAgent === "claude-code" || normalizedAgent === "ccr") {
    if (normalizedModel === "sonnet" || normalizedModel === "sonnet-4") {
      return "claude-sonnet-4-6";
    }
    if (normalizedModel === "opus" || normalizedModel === "opus-4") {
      return "claude-opus-4-6";
    }
    if (normalizedModel === "haiku" || normalizedModel === "haiku-4" || normalizedModel === "haiku-4-5") {
      return "claude-haiku-4-5";
    }
  }

  return trimmed;
}

function normalizePreferredReasoning(agent: string, reasoningEffort: string | null | undefined): string {
  const normalizedAgent = normalizeAgentName(agent);
  const normalizedReasoning = reasoningEffort?.trim().toLowerCase() ?? "";
  if (normalizedReasoning.length === 0) {
    return "";
  }

  if (normalizedAgent === "claude-code" || normalizedAgent === "ccr") {
    if (["minimal", "min", "off", "none", "low"].includes(normalizedReasoning)) return "low";
    if (["medium", "med"].includes(normalizedReasoning)) return "medium";
    if (normalizedReasoning === "high") return "high";
    if (["max", "xhigh", "extra-high", "extra_high", "extra high"].includes(normalizedReasoning)) {
      return "max";
    }
    return normalizedReasoning;
  }

  if (normalizedAgent === "github-copilot") {
    if (["minimal", "min", "off", "none", "low"].includes(normalizedReasoning)) return "low";
    if (["medium", "med"].includes(normalizedReasoning)) return "medium";
    if (normalizedReasoning === "high") return "high";
    if (["max", "xhigh", "extra-high", "extra_high", "extra high"].includes(normalizedReasoning)) {
      return "xhigh";
    }
    return normalizedReasoning;
  }

  if (normalizedAgent === "codex") {
    if (["minimal", "min", "low"].includes(normalizedReasoning)) return "low";
    if (["medium", "med"].includes(normalizedReasoning)) return "medium";
    if (normalizedReasoning === "high") return "high";
    if (["max", "xhigh", "extra-high", "extra_high", "extra high"].includes(normalizedReasoning)) {
      return "xhigh";
    }
    return normalizedReasoning;
  }

  if (normalizedAgent === "droid") {
    if (["minimal", "min"].includes(normalizedReasoning)) return "minimal";
    if (["medium", "med"].includes(normalizedReasoning)) return "medium";
    if (["extra-high", "extra_high", "extra high"].includes(normalizedReasoning)) return "xhigh";
    return normalizedReasoning;
  }

  if (normalizedAgent === "opencode") {
    if (["minimal", "min"].includes(normalizedReasoning)) return "minimal";
    if (["medium", "med"].includes(normalizedReasoning)) return "medium";
    if (["xhigh", "extra-high", "extra_high", "extra high"].includes(normalizedReasoning)) {
      return "max";
    }
    return normalizedReasoning;
  }

  if (normalizedAgent === "pi") {
    if (["minimal", "min"].includes(normalizedReasoning)) return "minimal";
    if (["medium", "med"].includes(normalizedReasoning)) return "medium";
    if (["max", "xhigh", "extra-high", "extra_high", "extra high"].includes(normalizedReasoning)) {
      return "xhigh";
    }
    return normalizedReasoning;
  }

  return normalizedReasoning;
}

export function emptyModelSelection(): ModelSelectionState {
  return {
    catalogModel: "",
    customModel: "",
    reasoningEffort: "",
  };
}

function getRuntimeModelCatalog(
  agent: string,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): RuntimeAgentModelCatalog | null {
  return runtimeModelCatalogs[normalizeAgentName(agent)] ?? null;
}

function getAllRuntimeCatalogModels(
  runtimeCatalog: RuntimeAgentModelCatalog | null,
): AgentModelOption[] {
  if (!runtimeCatalog) return [];

  const ordered: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const group of Object.values(runtimeCatalog.modelsByAccess)) {
    if (!Array.isArray(group)) continue;
    for (const model of group) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      ordered.push(model);
    }
  }
  return ordered;
}

function hasRuntimeModels(runtimeCatalog: RuntimeAgentModelCatalog | null): boolean {
  return getAllRuntimeCatalogModels(runtimeCatalog).length > 0;
}

export function getSelectableAgentModels(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): AgentModelOption[] {
  if (usesBackendManagedModelConfig(agent)) {
    return [];
  }

  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);
  const scopedModels = getRuntimeCatalogModelsForAccess(runtimeCatalog, access);
  const allRuntimeModels = getAllRuntimeCatalogModels(runtimeCatalog);

  if (runtimeCatalog) {
    const merged: AgentModelOption[] = [];
    const seen = new Set<string>();
    for (const model of [...scopedModels, ...allRuntimeModels]) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
    return merged;
  }

  return getAvailableAgentModels(agent, modelAccess);
}

export function getSelectableAgentReasoningOptions(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  model: string | null | undefined,
): AgentReasoningOption[] {
  if (usesBackendManagedModelConfig(agent)) {
    return [];
  }

  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);

  if (runtimeCatalog) {
    return getRuntimeCatalogReasoningOptions(runtimeCatalog, model, access);
  }

  return getAvailableAgentReasoningEfforts(agent, modelAccess);
}

export function getSelectableDefaultAgentModel(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): string {
  if (usesBackendManagedModelConfig(agent)) {
    return "";
  }

  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);

  if (runtimeCatalog) {
    return getRuntimeCatalogDefaultModelForAccess(runtimeCatalog, access)
      ?? getAllRuntimeCatalogModels(runtimeCatalog)[0]?.id
      ?? "";
  }

  return getDefaultAgentModel(agent, modelAccess) ?? "";
}

export function getSelectableDefaultReasoningEffort(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  model: string | null | undefined,
): string {
  if (usesBackendManagedModelConfig(agent)) {
    return "";
  }

  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);

  if (runtimeCatalog) {
    return getRuntimeCatalogDefaultReasoning(runtimeCatalog, model, access) ?? "";
  }

  return getDefaultAgentReasoningEffort(agent, modelAccess) ?? "";
}

export function getSelectableModelPlaceholder(
  agent: string,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): string {
  if (usesBackendManagedModelConfig(agent)) {
    return "";
  }

  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const runtimePlaceholder = runtimeCatalog?.customModelPlaceholder.trim();
  if (runtimePlaceholder) {
    return runtimePlaceholder;
  }
  const label = getAgentModelCatalog(agent)?.label ?? "agent";
  return `Enter exact ${label} model id`;
}

export function buildModelSelection(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  preferredModel?: string | null,
  preferredReasoningEffort?: string | null,
): ModelSelectionState {
  if (usesBackendManagedModelConfig(agent)) {
    return emptyModelSelection();
  }

  const trimmedPreferred = normalizePreferredModel(agent, preferredModel);
  const trimmedPreferredReasoning = normalizePreferredReasoning(agent, preferredReasoningEffort);
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const availableModels = getSelectableAgentModels(agent, modelAccess, runtimeModelCatalogs);
  const defaultModel = getSelectableDefaultAgentModel(agent, modelAccess, runtimeModelCatalogs);
  const runtimeModelsAreAuthoritative = runtimeCatalog !== null;

  const resolveReasoningEffort = (resolvedModel: string | null | undefined): string => {
    const options = getSelectableAgentReasoningOptions(
      agent,
      modelAccess,
      runtimeModelCatalogs,
      resolvedModel,
    );
    if (trimmedPreferredReasoning.length > 0 && options.some((option) => option.id === trimmedPreferredReasoning)) {
      return trimmedPreferredReasoning;
    }
    return getSelectableDefaultReasoningEffort(agent, modelAccess, runtimeModelCatalogs, resolvedModel);
  };

  if (trimmedPreferred.length > 0) {
    if (availableModels.some((model) => model.id === trimmedPreferred)) {
      return {
        catalogModel: trimmedPreferred,
        customModel: "",
        reasoningEffort: resolveReasoningEffort(trimmedPreferred),
      };
    }

    if (!runtimeModelsAreAuthoritative) {
      return {
        catalogModel: defaultModel,
        customModel: trimmedPreferred,
        reasoningEffort: resolveReasoningEffort(trimmedPreferred),
      };
    }
  }

  return {
    catalogModel: defaultModel,
    customModel: "",
    reasoningEffort: resolveReasoningEffort(defaultModel),
  };
}

export function resolveModelSelectionValue(selection: ModelSelectionState): string | undefined {
  const custom = selection.customModel.trim();
  if (custom.length > 0) return custom;
  const catalog = selection.catalogModel.trim();
  return catalog.length > 0 ? catalog : undefined;
}

export function resolveReasoningSelectionValue(selection: ModelSelectionState): string | undefined {
  const reasoningEffort = selection.reasoningEffort.trim().toLowerCase();
  return reasoningEffort.length > 0 ? reasoningEffort : undefined;
}
