import type {
  AgentModelAccess,
  AgentModelOption,
  AgentReasoningOption,
  SupportedModelAgent,
} from "@conductor-oss/core/types";

export interface RuntimeAgentModelCatalog {
  agent: SupportedModelAgent;
  customModelPlaceholder: string;
  defaultModelByAccess: Partial<Record<AgentModelAccess, string>>;
  modelsByAccess: Partial<Record<AgentModelAccess, AgentModelOption[]>>;
  defaultReasoningByAccess?: Partial<Record<AgentModelAccess, string>>;
  reasoningOptionsByAccess?: Partial<Record<AgentModelAccess, AgentReasoningOption[]>>;
  defaultReasoningByModel?: Record<string, string>;
  reasoningOptionsByModel?: Record<string, AgentReasoningOption[]>;
}

export function getRuntimeCatalogModelsForAccess(
  catalog: RuntimeAgentModelCatalog | null | undefined,
  access: string | null | undefined,
): AgentModelOption[] {
  if (!catalog || !access) return [];
  return catalog.modelsByAccess[access as AgentModelAccess] ?? [];
}

export function getRuntimeCatalogDefaultModelForAccess(
  catalog: RuntimeAgentModelCatalog | null | undefined,
  access: string | null | undefined,
): string | null {
  if (!catalog || !access) return null;
  return catalog.defaultModelByAccess[access as AgentModelAccess] ?? null;
}

export function getRuntimeCatalogReasoningOptions(
  catalog: RuntimeAgentModelCatalog | null | undefined,
  model: string | null | undefined,
  access: string | null | undefined,
): AgentReasoningOption[] {
  if (!catalog) return [];

  const normalizedModel = model?.trim();
  if (normalizedModel && catalog.reasoningOptionsByModel?.[normalizedModel]?.length) {
    return catalog.reasoningOptionsByModel[normalizedModel] ?? [];
  }

  if (!access) return [];
  return catalog.reasoningOptionsByAccess?.[access as AgentModelAccess] ?? [];
}

export function getRuntimeCatalogDefaultReasoning(
  catalog: RuntimeAgentModelCatalog | null | undefined,
  model: string | null | undefined,
  access: string | null | undefined,
): string | null {
  if (!catalog) return null;

  const normalizedModel = model?.trim();
  if (normalizedModel && catalog.defaultReasoningByModel?.[normalizedModel]) {
    return catalog.defaultReasoningByModel[normalizedModel] ?? null;
  }

  if (!access) return null;
  return catalog.defaultReasoningByAccess?.[access as AgentModelAccess] ?? null;
}
