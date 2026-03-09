import { normalizeAgentName } from "@/lib/agentUtils";

export type KnownAgent = {
  name: string;
  label: string;
  description: string;
  homepage: string | null;
  iconUrl: string | null;
  installHint?: string;
  installUrl?: string;
  setupUrl?: string;
};

export const KNOWN_AGENTS: KnownAgent[] = [
  {
    name: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    homepage: "https://github.com/openai/codex",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
    installHint: "npm install -g @openai/codex",
    installUrl: "https://github.com/openai/codex",
    setupUrl: "https://chatgpt.com/codex",
  },
  {
    name: "gemini",
    label: "Gemini",
    description: "Google Gemini CLI",
    homepage: "https://ai.google.dev/gemini-api/docs",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
    installHint: "npm install -g @google/gemini-cli",
    installUrl: "https://ai.google.dev/gemini-api/docs",
    setupUrl: "https://aistudio.google.com/",
  },
  {
    name: "qwen-code",
    label: "Qwen Code",
    description: "Qwen Code CLI",
    homepage: "https://qwenlm.github.io/announcements/",
    iconUrl: null,
    installHint: "npm install -g @qwen-code/qwen-code@latest",
    installUrl: "https://qwenlm.github.io/announcements/",
    setupUrl: "https://chat.qwen.ai/",
  },
  {
    name: "droid",
    label: "Droid",
    description: "Factory Droid CLI",
    homepage: "https://github.com/Factory-AI/factory",
    iconUrl: "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
    installHint: "npm install -g @factory/cli",
    installUrl: "https://github.com/Factory-AI/factory",
  },
  {
    name: "claude-code",
    label: "Claude Code",
    description: "Claude Code CLI",
    homepage: "https://www.anthropic.com/claude",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
    installHint: "npm install -g @anthropic-ai/claude-code",
    installUrl: "https://www.anthropic.com/claude-code",
    setupUrl: "https://claude.ai/",
  },
  {
    name: "amp",
    label: "Amp",
    description: "Amp Code CLI",
    homepage: "https://www.ampcode.com",
    iconUrl: "https://ampcode.com/amp-mark-color.svg",
    installHint: "npm install -g @sourcegraph/amp",
    installUrl: "https://www.ampcode.com",
  },
  {
    name: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI",
    homepage: "https://opencode.ai",
    iconUrl: null,
    installHint: "npm install -g opencode-ai",
    installUrl: "https://opencode.ai",
  },
  {
    name: "github-copilot",
    label: "GitHub Copilot",
    description: "GitHub Copilot CLI",
    homepage: "https://docs.github.com/copilot/how-tos/copilot-cli",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
    installHint: "npm install -g @github/copilot",
    installUrl: "https://docs.github.com/copilot/how-tos/copilot-cli",
    setupUrl: "https://github.com/settings/copilot",
  },
  {
    name: "cursor-cli",
    label: "Cursor Agent",
    description: "Cursor Agent CLI",
    homepage: "https://www.cursor.com",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
    installHint: "npm install -g cursor-agent",
  },
  {
    name: "ccr",
    label: "CCR",
    description: "Claude Code Router",
    homepage: "https://www.npmjs.com/package/@musistudio/claude-code-router",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
    installHint: "npm install -g @musistudio/claude-code-router",
    installUrl: "https://www.npmjs.com/package/@musistudio/claude-code-router",
  },
];

export const KNOWN_AGENT_ORDER = KNOWN_AGENTS.map((agent) => agent.name);

const KNOWN_AGENT_MAP = new Map(
  KNOWN_AGENTS.map((agent) => [normalizeAgentName(agent.name), agent] as const),
);

export function getKnownAgent(value: string): KnownAgent | null {
  return KNOWN_AGENT_MAP.get(normalizeAgentName(value)) ?? null;
}

export function getKnownAgentOrderIndex(value: string): number {
  const normalized = normalizeAgentName(value);
  const index = KNOWN_AGENT_ORDER.findIndex((agent) => normalizeAgentName(agent) === normalized);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}
