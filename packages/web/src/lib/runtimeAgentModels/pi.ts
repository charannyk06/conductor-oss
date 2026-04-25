import type { AgentModelAccess, AgentModelOption } from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  formatGenericModelLabel,
  readCommandOutput,
  toReasoningOption,
} from "./helpers";

export type PiModelRow = {
  provider: string;
  model: string;
  context?: string;
  maxOutput?: string;
  thinking: boolean;
  images?: boolean;
};

export function parsePiListModelsOutput(output: string): PiModelRow[] {
  const rows: PiModelRow[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("provider") || trimmed.startsWith("npm ")) {
      continue;
    }

    const parts = trimmed.split(/\s+/g);
    if (parts.length < 5) continue;

    const [provider, model, context, maxOutput, thinking, images] = parts;
    if (!provider || !model) continue;

    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);

    rows.push({
      provider,
      model,
      context,
      maxOutput,
      thinking: thinking?.toLowerCase() === "yes",
      images: images ? images.toLowerCase() === "yes" : undefined,
    });
  }

  return rows;
}

function piModelLabel(row: PiModelRow): string {
  return `${formatGenericModelLabel(row.model)} (${row.provider})`;
}

function piModelDescription(row: PiModelRow): string {
  const details = [`provider: ${row.provider}`];
  if (row.context) details.push(`context: ${row.context}`);
  if (row.maxOutput) details.push(`max output: ${row.maxOutput}`);
  return `Model exposed by the local Pi CLI (${details.join(", ")}).`;
}

export async function buildPiRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const output = await readCommandOutput(["pi"], ["--list-models"]);
  if (!output) {
    return null;
  }

  const rows = parsePiListModelsOutput(output);
  if (rows.length === 0) {
    return buildDefaultAccessRuntimeCatalog("pi", [], {
      customModelPlaceholder: "openai/gpt-5.5",
    });
  }

  const models: AgentModelOption[] = rows.map((row) => ({
    id: `${row.provider}/${row.model}`,
    label: piModelLabel(row),
    description: piModelDescription(row),
    access: ["default"] as AgentModelAccess[],
  }));

  const reasoningOptionsByModel: Record<string, ReturnType<typeof toReasoningOption>[]> = {};
  const defaultReasoningByModel: Record<string, string> = {};
  const thinkingOptions = ["low", "medium", "high", "xhigh"].map((value) => toReasoningOption(value));

  for (const row of rows) {
    if (!row.thinking) continue;
    const id = `${row.provider}/${row.model}`;
    reasoningOptionsByModel[id] = thinkingOptions;
    defaultReasoningByModel[id] = "high";
  }

  const preferredDefault = models.find((model) => model.id === "openai/gpt-5.5")
    ?? models.find((model) => model.id === "openai/gpt-5.4")
    ?? models[0];

  return buildDefaultAccessRuntimeCatalog("pi", models, {
    customModelPlaceholder: preferredDefault?.id ?? "openai/gpt-5.5",
    defaultModel: preferredDefault?.id ?? null,
    reasoningOptionsByModel,
    defaultReasoningByModel,
  });
}
