"use client";

import { normalizeAgentName } from "@/lib/agentUtils";
import {
  getAgentModelCatalog,
  getAvailableAgentModels,
  type AgentModelOption,
  type ModelAccessPreferences,
} from "@conductor-oss/core/types";

export function formatCurrentModelLabel(agentName: string, modelId: string): string {
  const normalizedModel = modelId.trim();
  const normalizedAgent = normalizeAgentName(agentName);
  if (!normalizedModel) return normalizedModel;

  if (normalizedAgent === "claude-code") {
    const lower = normalizedModel.toLowerCase();
    if (lower === "opus") return "Claude Opus";
    if (lower === "sonnet") return "Claude Sonnet";
    if (lower === "haiku") return "Claude Haiku";
    const match = lower.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-\d{8})?$/);
    if (match) {
      const family = match[1];
      return `Claude ${family[0]?.toUpperCase() + family.slice(1)} ${match[2]}.${match[3]}`;
    }
  }

  return normalizedModel
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((segment) => {
      const lower = segment.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (/^\d+(?:\.\d+)?$/.test(segment)) return segment;
      return segment[0]?.toUpperCase() + segment.slice(1);
    })
    .join("-");
}

export function getAllStaticModelOptions(agentName: string): AgentModelOption[] {
  const catalog = getAgentModelCatalog(agentName);
  if (!catalog) {
    return getAvailableAgentModels(agentName, undefined);
  }

  const options = new Map<string, AgentModelOption>();
  for (const accessOption of catalog.accessOptions) {
    const preferences = { [catalog.accessKey]: accessOption.id } as ModelAccessPreferences;
    for (const model of getAvailableAgentModels(agentName, preferences)) {
      if (!model?.id || options.has(model.id)) continue;
      options.set(model.id, model);
    }
  }

  return [...options.values()];
}
