import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentModelAccess,
  AgentModelOption,
  AgentReasoningOption,
  SupportedModelAgent,
} from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog, RuntimeAgentModelContext } from "../runtimeAgentModelsShared";
import { DEFAULT_REASONING_DESCRIPTIONS } from "./types";
import type { RecentFileMatchOptions } from "./types";

const execFileAsync = promisify(execFile);

export function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeTokenLimit(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}

export function buildRuntimeModelContext(
  values: {
    maxTokens?: unknown;
    inputMaxTokens?: unknown;
    outputMaxTokens?: unknown;
    source?: string | null;
    note?: string | null;
  },
): RuntimeAgentModelContext | null {
  const maxTokens = normalizeTokenLimit(values.maxTokens);
  const inputMaxTokens = normalizeTokenLimit(values.inputMaxTokens);
  const outputMaxTokens = normalizeTokenLimit(values.outputMaxTokens);
  const source = values.source?.trim() || undefined;
  const note = values.note?.trim() || undefined;

  if (maxTokens === null && inputMaxTokens === null && outputMaxTokens === null && !source && !note) {
    return null;
  }

  return {
    ...(maxTokens !== null ? { maxTokens } : {}),
    ...(inputMaxTokens !== null ? { inputMaxTokens } : {}),
    ...(outputMaxTokens !== null ? { outputMaxTokens } : {}),
    ...(source ? { source } : {}),
    ...(note ? { note } : {}),
  };
}

export async function readTextFileIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readCommandOutput(commands: string[], args: string[]): Promise<string | null> {
  for (const command of commands) {
    try {
      const result = await execFileAsync(command, args, {
        encoding: "utf8",
        timeout: 3_000,
        windowsHide: true,
        maxBuffer: 1_000_000,
      }) as { stdout?: string; stderr?: string };
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (output.length > 0) {
        return output;
      }
    } catch {
      // Try the next alias.
    }
  }
  return null;
}

export async function readJsonFileIfPresent<T>(path: string): Promise<T | null> {
  const contents = await readTextFileIfPresent(path);
  if (!contents) return null;
  try {
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

export function formatReasoningLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "xhigh") return "Extra High";
  return normalized
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function toReasoningOption(effort: string, description?: string | null): AgentReasoningOption {
  const normalized = effort.trim().toLowerCase();
  return {
    id: normalized,
    label: formatReasoningLabel(normalized),
    description: description?.trim() || DEFAULT_REASONING_DESCRIPTIONS[normalized] || "Reasoning effort supported by the local CLI.",
  };
}

export function pickRuntimeDefaultModel(
  availableModels: AgentModelOption[],
  configuredModel: string | null,
): string | null {
  if (configuredModel && availableModels.some((model) => model.id === configuredModel)) {
    return configuredModel;
  }
  return availableModels[0]?.id ?? null;
}

export function pickRuntimeDefaultReasoning(
  availableOptions: AgentReasoningOption[],
  configuredReasoning: string | null,
  fallbackReasoning: string | null,
): string | null {
  const normalizedConfigured = configuredReasoning?.trim().toLowerCase() ?? null;
  if (normalizedConfigured && availableOptions.some((option) => option.id === normalizedConfigured)) {
    return normalizedConfigured;
  }

  const normalizedFallback = fallbackReasoning?.trim().toLowerCase() ?? null;
  if (normalizedFallback && availableOptions.some((option) => option.id === normalizedFallback)) {
    return normalizedFallback;
  }

  const first = availableOptions[0]?.id;
  return typeof first === "string" && first.trim().length > 0 ? first : null;
}

export function uniqueModelOptions(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  const ordered: AgentModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    ordered.push(model);
  }
  return ordered;
}

export function uniqueStringValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

export function uniqueReasoningOptions(options: AgentReasoningOption[]): AgentReasoningOption[] {
  const seen = new Set<string>();
  const ordered: AgentReasoningOption[] = [];
  for (const option of options) {
    const normalized = option.id?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(option);
  }
  return ordered;
}

export function formatGenericModelLabel(raw: string): string {
  return raw
    .trim()
    .split(/[/:_-]+/g)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "api") return "API";
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function buildDefaultAccessRuntimeCatalog(
  agent: SupportedModelAgent,
  models: AgentModelOption[],
  options: {
    customModelPlaceholder?: string | null;
    defaultModel?: string | null;
    modelContextById?: Record<string, RuntimeAgentModelContext>;
    reasoningOptions?: AgentReasoningOption[];
    defaultReasoning?: string | null;
    reasoningOptionsByModel?: Record<string, AgentReasoningOption[]>;
    defaultReasoningByModel?: Record<string, string>;
  } = {},
): RuntimeAgentModelCatalog | null {
  const availableModels = uniqueModelOptions(models);
  const defaultModel = pickRuntimeDefaultModel(availableModels, options.defaultModel ?? null);
  const reasoningOptions = uniqueReasoningOptions(options.reasoningOptions ?? []);
  const defaultReasoning = pickRuntimeDefaultReasoning(
    reasoningOptions,
    options.defaultReasoning ?? null,
    options.defaultReasoning ?? null,
  );

  if (availableModels.length === 0 && !options.customModelPlaceholder?.trim()) {
    return null;
  }

  return {
    agent,
    customModelPlaceholder: options.customModelPlaceholder?.trim()
      || defaultModel
      || availableModels[0]?.id
      || "",
    defaultModelByAccess: {
      ...(defaultModel ? { default: defaultModel } : {}),
    },
    modelsByAccess: {
      ...(availableModels.length > 0 ? { default: availableModels } : {}),
    },
    ...(options.modelContextById && Object.keys(options.modelContextById).length > 0
      ? { modelContextById: options.modelContextById }
      : {}),
    ...(reasoningOptions.length > 0
      ? {
          reasoningOptionsByAccess: {
            default: reasoningOptions,
          },
        }
      : {}),
    ...(defaultReasoning
      ? {
          defaultReasoningByAccess: {
            default: defaultReasoning,
          },
        }
      : {}),
    ...(options.reasoningOptionsByModel && Object.keys(options.reasoningOptionsByModel).length > 0
      ? { reasoningOptionsByModel: options.reasoningOptionsByModel }
      : {}),
    ...(options.defaultReasoningByModel && Object.keys(options.defaultReasoningByModel).length > 0
      ? { defaultReasoningByModel: options.defaultReasoningByModel }
      : {}),
  };
}

export function toRuntimeModelOption(
  id: string,
  description: string,
  access: AgentModelAccess[],
  labelFormatter: (value: string) => string,
): AgentModelOption {
  return {
    id,
    label: labelFormatter(id),
    description,
    access,
  };
}

export async function readCommandHelp(commands: string[]): Promise<string | null> {
  for (const command of commands) {
    try {
      const result = await execFileAsync(command, ["--help"], {
        encoding: "utf8",
        timeout: 1_500,
        windowsHide: true,
        maxBuffer: 256_000,
      }) as { stdout?: string; stderr?: string };
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (output.length > 0) {
        return output;
      }
    } catch {
      // Try the next alias.
    }
  }
  return null;
}

export async function collectRecentFiles(rootDir: string, options: RecentFileMatchOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 5;
  const maxFiles = options.maxFiles ?? 24;
  const maxDirectories = options.maxDirectories ?? 64;
  const extensions = new Set((options.extensions ?? []).map((value) => value.toLowerCase()));
  const files: Array<{ path: string; mtimeMs: number }> = [];
  let visitedDirectories = 0;

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || visitedDirectories >= maxDirectories) return;
    visitedDirectories += 1;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    if (files.length >= maxFiles * 3 && depth > 1) {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
        return;
      }
      if (!entry.isFile()) return;
      if (options.filenamePattern && !options.filenamePattern.test(entry.name)) return;
      if (extensions.size > 0 && !extensions.has(extname(entry.name).toLowerCase())) return;

      try {
        const fileStats = await stat(fullPath);
        files.push({ path: fullPath, mtimeMs: fileStats.mtimeMs });
      } catch {
        // Ignore files that disappear during the scan.
      }
    }));
  }

  await walk(rootDir, 0);

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

export async function collectRegexMatchesFromRecentFiles(
  rootDir: string,
  pattern: RegExp,
  options: RecentFileMatchOptions = {},
): Promise<string[]> {
  const files = await collectRecentFiles(rootDir, options);
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const contents = await readTextFileIfPresent(file);
    if (!contents) continue;

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(contents)) !== null) {
      const rawValue = match[1]?.trim();
      if (!rawValue || seen.has(rawValue)) continue;
      seen.add(rawValue);
      matches.push(rawValue);
    }
  }

  return matches;
}

export async function detectReasoningOptionsFromHelp(commands: string[]): Promise<AgentReasoningOption[]> {
  const help = await readCommandHelp(commands);
  if (!help) return [];

  const match = help.match(/--effort\s+<[^>]+>.*?\(([^)]+)\)/s);
  if (!match?.[1]) return [];

  return uniqueStringValues(
    match[1]
      .split(",")
      .map((value) => value.trim().toLowerCase()),
  ).map((effort) => toReasoningOption(effort));
}

export function extractQuotedChoices(help: string, optionName: string): string[] {
  const matcher = new RegExp(`${optionName}[\\s\\S]*?\\(choices:\\s*([^)]+)\\)`, "i");
  const match = help.match(matcher);
  if (!match?.[1]) {
    return [];
  }

  return uniqueStringValues(
    Array.from(match[1].matchAll(/"([^"]+)"/g), (entry) => entry[1]?.trim()),
  );
}

export function extractReasoningOptionsFromVariantKeys(keys: string[]): AgentReasoningOption[] {
  return uniqueReasoningOptions(keys.map((key) => toReasoningOption(key)));
}
