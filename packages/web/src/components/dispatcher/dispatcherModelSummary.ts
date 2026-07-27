import { getKnownAgent } from "@/lib/knownAgents";
import { formatCurrentModelLabel } from "@/lib/sessionModelCatalog";

export function formatDispatcherReasoningLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
    case "xhigh":
    case "extra-high":
    case "extra_high":
    case "extra high":
      return "Max";
    default:
      return normalized
        .split(/[_-\s]+/g)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function buildDispatcherRuntimeSummary(input: {
  agent: string;
  model: string | null | undefined;
  reasoningEffort: string | null | undefined;
}): string {
  const agentLabel = getKnownAgent(input.agent)?.label ?? input.agent;
  const segments = [agentLabel];
  const modelLabel = input.model?.trim() ? formatCurrentModelLabel(input.agent, input.model.trim()) : null;
  const reasoningLabel = formatDispatcherReasoningLabel(input.reasoningEffort);

  if (modelLabel) {
    segments.push(modelLabel);
  }
  if (reasoningLabel) {
    segments.push(reasoningLabel);
  }

  return segments.join(" · ");
}
