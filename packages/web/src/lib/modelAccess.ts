import {
  getDefaultModelAccessPreferences,
  type ModelAccessPreferences,
} from "@conductor-oss/core/types";

const CLAUDE_ACCESS = ["pro", "max", "api"] as const;
const CODEX_ACCESS = ["chatgpt", "api"] as const;
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
    claudeCode: selectValue(root["claudeCode"], CLAUDE_ACCESS, defaults.claudeCode),
    codex: selectValue(root["codex"], CODEX_ACCESS, defaults.codex),
    gemini: selectValue(root["gemini"], GEMINI_ACCESS, defaults.gemini),
    qwenCode: selectValue(root["qwenCode"], QWEN_ACCESS, defaults.qwenCode),
  };
}
