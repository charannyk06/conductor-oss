export const AGENT_NAME_ALIASES: Record<string, string> = {
  cc: "claude-code",
  claude: "claude-code",
  "claude-code-cli": "claude-code",
  "claude_code_cli": "claude-code",
  "claude-code-router": "ccr",
  "ccr-cli": "ccr",
  "claude_code_router": "ccr",
  "claude code router": "ccr",
  cursor: "cursor-cli",
  "cursor-agent": "cursor-cli",
  "cursor-agent-cli": "cursor-cli",
  "cursor_agent": "cursor-cli",
  cursoragent: "cursor-cli",
  "cursorcli": "cursor-cli",
  "copilot": "github-copilot",
  "copilot-cli": "github-copilot",
  "copilot cli": "github-copilot",
  "github-copilot-cli": "github-copilot",
  "gh-copilot": "github-copilot",
  "github-copilot": "github-copilot",
  "google-gemini": "gemini",
  "google-gemini-cli": "gemini",
  gm: "gemini",
  gem: "gemini",
  "gemini-cli": "gemini",
  gemini: "gemini",
  amp: "amp",
  "amp-cli": "amp",
  "open-code": "opencode",
  "open-code-cli": "opencode",
  "open code": "opencode",
  "open_code": "opencode",
  "openai": "codex",
  "open-ai": "codex",
  "openai-codex": "codex",
  "open-ai-codex": "codex",
  "openai-codex-cli": "codex",
  "openai_codex": "codex",
  "codex-cli": "codex",
  codexcli: "codex",
  codex: "codex",
  "qwen-code-cli": "qwen-code",
  qwen: "qwen-code",
  "qwen_code": "qwen-code",
  "qwen code": "qwen-code",
  "qwen-code": "qwen-code",
  "factory-droid": "droid",
  "factory_droid": "droid",
  droid: "droid",
};

export function normalizeAgentName(value: string, supportedAgents?: readonly string[]): string {
  const normalizedInput = value.trim().toLowerCase();
  let normalized = "";
  let previousWasDash = false;

  for (const ch of normalizedInput) {
    let replacement = "";

    if (ch >= "a" && ch <= "z") {
      replacement = ch;
    } else if (ch >= "0" && ch <= "9") {
      replacement = ch;
    } else if (ch === "-" || ch === "_" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      replacement = "-";
    } else {
      replacement = "-";
    }

    if (replacement === "-") {
      if (!previousWasDash && normalized.length > 0) {
        normalized += replacement;
      }
      previousWasDash = true;
    } else {
      normalized += replacement;
      previousWasDash = false;
    }
  }

  if (normalized.endsWith("-")) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) return "";

  const alias = AGENT_NAME_ALIASES[normalized];
  if (alias) {
    const normalizedAlias = supportedAgents
      ? supportedAgents.find((name) => name.toLowerCase() === alias)
      : alias;
    return normalizedAlias ?? alias;
  }

  const exact = supportedAgents
    ? supportedAgents.find((name) => name.toLowerCase() === normalized)
    : undefined;
  if (exact) return exact;

  const prefixed = supportedAgents
    ? supportedAgents.find((name) => name.toLowerCase().includes(normalized))
    : undefined;

  if (prefixed) return prefixed;
  return normalized;
}

export function isSupportedAgent(agent: string, supportedAgents: readonly string[]): boolean {
  return supportedAgents.some((name) => name.toLowerCase() === agent.toLowerCase());
}
