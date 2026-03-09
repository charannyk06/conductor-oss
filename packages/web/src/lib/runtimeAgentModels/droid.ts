import type {
  AgentModelAccess,
  AgentModelOption,
  AgentReasoningOption,
} from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import type { DroidModelDetail } from "./types";
import {
  buildDefaultAccessRuntimeCatalog,
  readCommandOutput,
  toReasoningOption,
  uniqueModelOptions,
  uniqueStringValues,
} from "./helpers";

function buildDroidReasoningDetails(help: string): Map<string, DroidModelDetail> {
  const detailSection = help.split("Model details:")[1] ?? "";
  const details = new Map<string, DroidModelDetail>();

  for (const rawLine of detailSection.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;

    const match = line.match(/^- (.+?): supports reasoning:\s+(Yes|No);\s+supported:\s+\[([^\]]*)\];\s+default:\s+([^\s]+)/i);
    if (!match) continue;

    const label = match[1]?.trim();
    const supported = uniqueStringValues(
      match[3]
        ?.split(",")
        .map((value) => value.trim().toLowerCase()),
    );
    const reasoningOptions = supported
      .filter((value) => value.length > 0)
      .map((value) => toReasoningOption(value));
    details.set(label, {
      reasoningOptions,
      defaultReasoning: match[4]?.trim().toLowerCase() ?? null,
    });
  }

  return details;
}

export async function buildDroidRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const help = await readCommandOutput(["droid"], ["exec", "--help"]);
  if (!help) {
    return null;
  }

  const availableSection = help.split("Available Models:")[1]?.split("Model details:")[0] ?? "";
  const detailMap = buildDroidReasoningDetails(help);
  const reasoningOptionsByModel: Record<string, AgentReasoningOption[]> = {};
  const defaultReasoningByModel: Record<string, string> = {};
  let explicitDefaultModel: string | null = null;

  const models = uniqueModelOptions(
    availableSection
      .split(/\r?\n/)
      .map((rawLine) => rawLine.trimEnd())
      .map((line) => {
        const match = line.match(/^\s*([^\s]+)\s+(.+)$/);
        if (!match) return null;

        const id = match[1]?.trim();
        const rawLabel = match[2]?.trim() ?? "";
        if (!id || !rawLabel) return null;

        const isDefault = rawLabel.includes("(default)");
        const cleanLabel = rawLabel.replace(/\s*\(default\)\s*/i, "").trim();
        if (isDefault) {
          explicitDefaultModel = id;
        }

        const detail = detailMap.get(cleanLabel);
        if (detail?.reasoningOptions.length) {
          reasoningOptionsByModel[id] = detail.reasoningOptions;
        }
        if (detail?.defaultReasoning) {
          defaultReasoningByModel[id] = detail.defaultReasoning;
        }

        return {
          id,
          label: cleanLabel,
          description: `${cleanLabel} available through the local Droid CLI (${id}).`,
          access: ["default"] as AgentModelAccess[],
        };
      })
      .filter((value): value is AgentModelOption => Boolean(value)),
  );

  if (models.length === 0) {
    return null;
  }

  return buildDefaultAccessRuntimeCatalog("droid", models, {
    customModelPlaceholder: "claude-opus-4-6 or custom:your-model",
    defaultModel: explicitDefaultModel ?? models[0]?.id ?? null,
    reasoningOptionsByModel,
    defaultReasoningByModel,
  });
}
