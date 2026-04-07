export type AgentTileIconSeed = {
  label: string;
  iconUrl?: string | null;
  homepage?: string | null;
};

type AgentIconKey =
  | "amp"
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "discord"
  | "droid"
  | "gemini"
  | "hermes"
  | "openclaw"
  | "opencode"
  | "qwen";

const AGENT_ICON_ALIASES: Record<AgentIconKey, string[]> = {
  amp: ["amp", "amp-code", "amp-cli", "ampcode", "agent-amp"],
  claude: [
    "claude",
    "claude-code",
    "claude-cli",
    "claudecode",
    "ccr",
    "claude-code-router",
    "claude-mcp",
    "claude-mcp-cli",
    "claude-mcp-agent",
    "agent-claude-code",
  ],
  codex: ["codex", "openai-codex", "codex-cli", "codexcli", "openai", "agent-codex"],
  copilot: ["copilot", "github-copilot", "githubcopilot", "copilot-cli", "agent-github-copilot"],
  cursor: ["cursor", "cursor-cli", "cursor-agent", "cursoragent", "agent-cursor-cli"],
  discord: ["discord"],
  droid: ["droid", "factory-droid", "factory_droid", "agent-droid"],
  gemini: ["gemini", "gemini-cli", "google-gemini", "googlegemini", "agent-gemini"],
  hermes: ["hermes", "hermes-agent", "nous-hermes", "agent-hermes"],
  openclaw: ["openclaw", "open-claw", "open_claw", "agent-openclaw"],
  opencode: ["opencode", "open-code", "open_code", "open-code-cli", "agent-opencode"],
  qwen: ["qwen", "qwen-code", "qwen_code", "qwen-code-cli", "agent-qwen-code"],
};

const AGENT_LOCAL_ICON_SOURCES: Record<AgentIconKey, string[]> = {
  amp: ["/agents/amp-dark.svg", "/agents/amp-light.svg"],
  claude: ["/agents/claude-dark.svg", "/agents/claude-light.svg"],
  codex: ["/agents/codex-dark.svg", "/agents/codex-light.svg"],
  copilot: ["/agents/copilot-dark.svg", "/agents/copilot-light.svg"],
  cursor: ["/agents/cursor-dark.svg", "/agents/cursor-light.svg"],
  discord: ["/agents/discord-dark.svg", "/agents/discord-light.svg"],
  droid: ["/agents/droid-dark.svg", "/agents/droid-light.svg"],
  gemini: ["/agents/gemini-dark.svg", "/agents/gemini-light.svg"],
  hermes: ["/agents/hermes.png"],
  openclaw: ["/agents/openclaw-dark.svg", "/agents/openclaw-light.svg"],
  opencode: ["/agents/opencode-dark.svg", "/agents/opencode-light.svg"],
  qwen: ["/agents/qwen-dark.svg", "/agents/qwen-light.svg"],
};

const ALIAS_TO_ICON = new Map<string, AgentIconKey>();
for (const [iconKey, aliases] of Object.entries(AGENT_ICON_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_ICON.set(normalize(alias), iconKey as AgentIconKey);
  }
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveAlias(value: string): AgentIconKey | null {
  const normalized = normalize(value);
  if (!normalized) return null;

  const direct = ALIAS_TO_ICON.get(normalized);
  if (direct) return direct;

  for (const token of normalized.split("-")) {
    const byToken = ALIAS_TO_ICON.get(token);
    if (byToken) return byToken;
  }

  for (const [alias, iconKey] of ALIAS_TO_ICON.entries()) {
    if (
      normalized === alias ||
      normalized.startsWith(`${alias}-`) ||
      normalized.endsWith(`-${alias}`) ||
      normalized.includes(`-${alias}-`)
    ) {
      return iconKey;
    }
  }

  return null;
}

function resolveFromUrl(value: string): AgentIconKey | null {
  try {
    const parsed = new URL(value);
    const hostKey = resolveAlias(parsed.hostname.replace(/^www\./, "").replace(/\./g, "-"));
    if (hostKey) return hostKey;
    return resolveAlias(parsed.pathname.replace(/\//g, "-"));
  } catch {
    return resolveAlias(value);
  }
}

export function resolveAgentIconKey(seed: AgentTileIconSeed): AgentIconKey | null {
  return resolveAlias(seed.label) ??
    (seed.homepage ? resolveFromUrl(seed.homepage) : null) ??
    (seed.iconUrl ? resolveFromUrl(seed.iconUrl) : null);
}

export function resolveAgentIconSources(seed: AgentTileIconSeed): string[] {
  const label = seed.label.trim();
  if (!label) {
    return [];
  }

  const key = resolveAgentIconKey(seed);
  const externalSrc = typeof seed.iconUrl === "string" && seed.iconUrl.trim().length > 0
    ? seed.iconUrl.trim()
    : null;

  const list: string[] = [];
  if (key) {
    list.push(...AGENT_LOCAL_ICON_SOURCES[key]);
  }
  if (externalSrc) {
    list.push(externalSrc);
  }
  return list;
}
