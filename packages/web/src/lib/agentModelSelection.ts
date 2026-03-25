import {
  getAgentModelCatalog,
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
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);
  const scopedModels = getRuntimeCatalogModelsForAccess(runtimeCatalog, access);
  const allRuntimeModels = getAllRuntimeCatalogModels(runtimeCatalog);

  if (allRuntimeModels.length > 0) {
    const merged: AgentModelOption[] = [];
    const seen = new Set<string>();
    for (const model of [...scopedModels, ...allRuntimeModels]) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
    return merged;
  }

  return [];
}

export function getSelectableAgentReasoningOptions(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  model: string | null | undefined,
): AgentReasoningOption[] {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);

  if (runtimeCatalog) {
    return getRuntimeCatalogReasoningOptions(runtimeCatalog, model, access);
  }

  return [];
}

export function getSelectableDefaultAgentModel(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): string {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);

  if (runtimeCatalog) {
    return getRuntimeCatalogDefaultModelForAccess(runtimeCatalog, access)
      ?? getAllRuntimeCatalogModels(runtimeCatalog)[0]?.id
      ?? "";
  }

  return "";
}

export function getSelectableDefaultReasoningEffort(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  model: string | null | undefined,
): string {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);

  if (runtimeCatalog) {
    return getRuntimeCatalogDefaultReasoning(runtimeCatalog, model, access) ?? "";
  }

  return "";
}

export function getSelectableModelPlaceholder(
  agent: string,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): string {
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
  const trimmedPreferred = preferredModel?.trim() ?? "";
  const trimmedPreferredReasoning = preferredReasoningEffort?.trim().toLowerCase() ?? "";
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const availableModels = getSelectableAgentModels(agent, modelAccess, runtimeModelCatalogs);
  const defaultModel = getSelectableDefaultAgentModel(agent, modelAccess, runtimeModelCatalogs);
  const runtimeModelsAreAuthoritative = hasRuntimeModels(runtimeCatalog);

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
