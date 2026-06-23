export type AgentSetupStatusInput = {
  checking?: boolean;
  installed?: boolean;
  ready?: boolean;
  configured?: boolean;
} | null | undefined;

export function agentSetupStatusLabel(state: AgentSetupStatusInput): string {
  if (state?.checking) return "Checking install";
  if (!state?.installed) return "Install needed";
  if (state.ready) return "CLI ready";
  if (state.configured === false) return "Auth needed";
  return "Setup needed";
}

export function agentModelAccessBadgeLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  return trimmed ? `Access: ${trimmed}` : null;
}
