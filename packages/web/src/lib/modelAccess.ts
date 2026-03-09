import {
  getDefaultModelAccessPreferences,
  type ModelAccessPreferences,
} from "@conductor-oss/core/types";

const CLAUDE_ACCESS = ["pro", "max", "api"] as const;
const CODEX_ACCESS = ["chatgpt", "api"] as const;
const DEFAULT_ACCESS = ["default"] as const;
const GEMINI_ACCESS = ["oauth", "api"] as const;
const QWEN_ACCESS = ["oauth", "api"] as const;

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function selectValue<T extends string>(
  value: unknown,
  supported: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && supported.includes(value as T)
    ? value as T
    : fallback;
}

export function normalizeModelAccessPreferences(
  value: unknown,
): Required<ModelAccessPreferences> {
  const root = toObject(value);
  const defaults = getDefaultModelAccessPreferences();

  return {
    amp: selectValue(root["amp"], DEFAULT_ACCESS, defaults.amp),
    claudeCode: selectValue(root["claudeCode"], CLAUDE_ACCESS, defaults.claudeCode),
    codex: selectValue(root["codex"], CODEX_ACCESS, defaults.codex),
    cursorCli: selectValue(root["cursorCli"], DEFAULT_ACCESS, defaults.cursorCli),
    droid: selectValue(root["droid"], DEFAULT_ACCESS, defaults.droid),
    gemini: selectValue(root["gemini"], GEMINI_ACCESS, defaults.gemini),
    githubCopilot: selectValue(root["githubCopilot"], DEFAULT_ACCESS, defaults.githubCopilot),
    opencode: selectValue(root["opencode"], DEFAULT_ACCESS, defaults.opencode),
    qwenCode: selectValue(root["qwenCode"], QWEN_ACCESS, defaults.qwenCode),
    ccr: selectValue(root["ccr"], DEFAULT_ACCESS, defaults.ccr),
  };
}
