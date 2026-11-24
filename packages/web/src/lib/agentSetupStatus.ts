/** Sign-in state the backend reports for subscription-backed agent CLIs. */
export type AgentAuthStatus = {
  state: "signed_in" | "signed_out" | "unknown";
  method: "subscription" | "api_key" | null;
  plan: string | null;
  loginCommand: string | null;
};

export type AgentSetupStatusInput = {
  checking?: boolean;
  installed?: boolean;
  ready?: boolean;
  configured?: boolean;
  auth?: AgentAuthStatus | null;
} | null | undefined;

export function parseAgentAuthStatus(value: unknown): AgentAuthStatus | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== "signed_in" && state !== "signed_out" && state !== "unknown") return null;
  const method = record.method === "subscription" || record.method === "api_key" ? record.method : null;
  const plan = typeof record.plan === "string" && record.plan.trim() ? record.plan.trim() : null;
  const loginCommand = typeof record.loginCommand === "string" && record.loginCommand.trim()
    ? record.loginCommand.trim()
    : null;
  return { state, method, plan, loginCommand };
}

export function agentSetupStatusLabel(state: AgentSetupStatusInput): string {
  if (state?.checking) return "Checking install";
  if (!state?.installed) return "Install needed";
  if (state.auth?.state === "signed_out") return "Sign-in needed";
  if (state.ready) {
    if (state.auth?.state === "signed_in" && state.auth.method === "subscription") {
      return state.auth.plan ? `Subscription connected (${state.auth.plan})` : "Subscription connected";
    }
    if (state.auth?.state === "signed_in" && state.auth.method === "api_key") return "API key connected";
    return "CLI ready";
  }
  if (state.configured === false) return "Auth needed";
  return "Setup needed";
}

export function agentModelAccessBadgeLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  return trimmed ? `Access: ${trimmed}` : null;
}
