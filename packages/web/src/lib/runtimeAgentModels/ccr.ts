import type {
  AgentModelOption,
  AgentReasoningOption,
} from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  readCommandOutput,
  uniqueModelOptions,
  uniqueReasoningOptions,
} from "./helpers";
import { buildClaudeRuntimeModelCatalog } from "./claude";

export async function buildCcrRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const version = await readCommandOutput(["ccr"], ["version"]);
  if (!version) {
    return null;
  }

  const claudeCatalog = await buildClaudeRuntimeModelCatalog();
  if (!claudeCatalog) {
    return null;
  }

  const models = uniqueModelOptions(
    Object.values(claudeCatalog.modelsByAccess)
      .flat()
      .filter((value): value is AgentModelOption => Boolean(value)),
  );
  const reasoningOptions = uniqueReasoningOptions(
    Object.values(claudeCatalog.reasoningOptionsByAccess ?? {})
      .flat()
      .filter((value): value is AgentReasoningOption => Boolean(value)),
  );
  const defaultModel = Object.values(claudeCatalog.defaultModelByAccess)[0] ?? models[0]?.id ?? null;
  const defaultReasoning = Object.values(claudeCatalog.defaultReasoningByAccess ?? {})[0] ?? null;

  return buildDefaultAccessRuntimeCatalog("ccr", models, {
    customModelPlaceholder: claudeCatalog.customModelPlaceholder,
    defaultModel,
    modelContextById: claudeCatalog.modelContextById,
    reasoningOptions,
    defaultReasoning,
    reasoningOptionsByModel: claudeCatalog.reasoningOptionsByModel,
    defaultReasoningByModel: claudeCatalog.defaultReasoningByModel,
  });
}
