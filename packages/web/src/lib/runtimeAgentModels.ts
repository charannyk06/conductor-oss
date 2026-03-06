import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import {
  resolveAgentModelAccess,
  type AgentModelAccess,
  type AgentModelOption,
  type AgentReasoningOption,
  type ModelAccessPreferences,
  type SupportedModelAgent,
} from "@conductor-oss/core/types";
import {
  getRuntimeCatalogDefaultModelForAccess,
  getRuntimeCatalogDefaultReasoning,
  type RuntimeAgentModelCatalog,
} from "./runtimeAgentModelsShared";

const execFileAsync = promisify(execFile);

type CodexCacheReasoningLevel = {
  effort?: unknown;
  description?: unknown;
};

type CodexCacheModel = {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  priority?: unknown;
};

type ClaudeSettings = {
  model?: unknown;
  alwaysThinkingEnabled?: unknown;
};

type ClaudeStatsCache = {
  dailyModelTokens?: Array<{
    tokensByModel?: Record<string, unknown>;
  }>;
};

type SimpleAuthSettings = {
  security?: {
    auth?: {
      selectedType?: unknown;
    };
  };
};

type RecentFileMatchOptions = {
  extensions?: string[];
  filenamePattern?: RegExp;
  maxDepth?: number;
  maxFiles?: number;
};

const DEFAULT_REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning.",
  medium: "Balanced speed and reasoning depth for everyday tasks.",
  high: "Deeper reasoning for more complex tasks.",
  xhigh: "Maximum reasoning depth for the hardest tasks.",
};

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function readTextFileIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFileIfPresent<T>(path: string): Promise<T | null> {
  const contents = await readTextFileIfPresent(path);
  if (!contents) return null;
  try {
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

function formatReasoningLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "xhigh") return "Extra High";
  return normalized
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function toReasoningOption(effort: string, description?: string | null): AgentReasoningOption {
  const normalized = effort.trim().toLowerCase();
  return {
    id: normalized,
    label: formatReasoningLabel(normalized),
    description: description?.trim() || DEFAULT_REASONING_DESCRIPTIONS[normalized] || "Reasoning effort supported by the local CLI.",
  };
}

function pickRuntimeDefaultModel(
  availableModels: AgentModelOption[],
  configuredModel: string | null,
): string | null {
  if (configuredModel && availableModels.some((model) => model.id === configuredModel)) {
    return configuredModel;
  }
  return availableModels[0]?.id ?? null;
}

function pickRuntimeDefaultReasoning(
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

function uniqueModelOptions(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  const ordered: AgentModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    ordered.push(model);
  }
  return ordered;
}

function uniqueStringValues(values: Array<string | null | undefined>): string[] {
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

function formatCodexModelLabel(raw: string): string {
  return raw
    .trim()
    .split("-")
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "codex") return "Codex";
      if (lower === "spark") return "Spark";
      if (lower === "mini") return "Mini";
      if (lower === "max") return "Max";
      if (index === 0) return part.toUpperCase();
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join("-");
}

function toCodexModelOption(entry: CodexCacheModel): AgentModelOption | null {
  if (typeof entry.slug !== "string" || entry.slug.trim().length === 0) {
    return null;
  }

  const slug = entry.slug.trim();
  const rawLabel = typeof entry.display_name === "string" && entry.display_name.trim().length > 0
    ? entry.display_name.trim()
    : slug;

  return {
    id: slug,
    label: formatCodexModelLabel(rawLabel),
    description: typeof entry.description === "string" && entry.description.trim().length > 0
      ? entry.description.trim()
      : `Model exposed by the local Codex installation (${slug}).`,
    access: entry.supported_in_api === false ? ["chatgpt"] : ["chatgpt", "api"],
  };
}

function parseCodexReasoningOptions(entry: CodexCacheModel): AgentReasoningOption[] {
  const rawLevels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as CodexCacheReasoningLevel[]
    : [];

  return rawLevels
    .map((level) => {
      if (typeof level.effort !== "string" || level.effort.trim().length === 0) {
        return null;
      }
      return toReasoningOption(
        level.effort,
        typeof level.description === "string" ? level.description : null,
      );
    })
    .filter((option): option is AgentReasoningOption => Boolean(option));
}

async function readCodexConfiguredState(): Promise<{ model: string | null; reasoningEffort: string | null }> {
  const contents = await readTextFileIfPresent(join(homedir(), ".codex", "config.toml"));
  if (!contents) {
    return { model: null, reasoningEffort: null };
  }

  const modelMatch = contents.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
  const reasoningMatch = contents.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$/m);

  return {
    model: modelMatch?.[1]?.trim() || null,
    reasoningEffort: reasoningMatch?.[1]?.trim().toLowerCase() || null,
  };
}

export function parseCodexRuntimeModelCatalog(
  value: unknown,
  configuredModel: string | null = null,
  configuredReasoningEffort: string | null = null,
): RuntimeAgentModelCatalog | null {
  if (!value || typeof value !== "object") return null;

  const models = Array.isArray((value as { models?: unknown }).models)
    ? (value as { models: CodexCacheModel[] }).models
    : [];

  const listedModels = models
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.visibility === "list")
    .sort((left, right) => {
      const leftPriority = typeof left.entry.priority === "number" ? left.entry.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.entry.priority === "number" ? right.entry.priority : Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.index - right.index;
    })
    .map(({ entry }) => ({ option: toCodexModelOption(entry), entry }))
    .filter((entry): entry is { option: AgentModelOption; entry: CodexCacheModel } => Boolean(entry.option));

  if (listedModels.length === 0) return null;

  const reasoningOptionsByModel: Record<string, AgentReasoningOption[]> = {};
  const defaultReasoningByModel: Record<string, string> = {};

  for (const { option, entry } of listedModels) {
    const reasoningOptions = parseCodexReasoningOptions(entry);
    if (reasoningOptions.length > 0) {
      reasoningOptionsByModel[option.id] = reasoningOptions;
      const defaultReasoning = typeof entry.default_reasoning_level === "string"
        ? entry.default_reasoning_level.trim().toLowerCase()
        : null;
      const resolvedDefaultReasoning = pickRuntimeDefaultReasoning(
        reasoningOptions,
        configuredReasoningEffort,
        defaultReasoning,
      );
      if (resolvedDefaultReasoning) {
        defaultReasoningByModel[option.id] = resolvedDefaultReasoning;
      }
    }
  }

  const chatgptModels = listedModels.map(({ option }) => option);
  const apiModels = listedModels
    .map(({ option }) => option)
    .filter((model) => model.access.includes("api"));

  const fallbackPlaceholder = configuredModel?.trim() || chatgptModels[0]?.id || "";
  const chatgptDefault = pickRuntimeDefaultModel(chatgptModels, configuredModel);
  const apiDefault = pickRuntimeDefaultModel(apiModels, configuredModel);

  const defaultReasoningByAccess: Partial<Record<AgentModelAccess, string>> = {};
  if (chatgptDefault) {
    const chatgptReasoning = pickRuntimeDefaultReasoning(
      reasoningOptionsByModel[chatgptDefault] ?? [],
      configuredReasoningEffort,
      defaultReasoningByModel[chatgptDefault] ?? null,
    );
    if (chatgptReasoning) defaultReasoningByAccess.chatgpt = chatgptReasoning;
  }
  if (apiDefault) {
    const apiReasoning = pickRuntimeDefaultReasoning(
      reasoningOptionsByModel[apiDefault] ?? [],
      configuredReasoningEffort,
      defaultReasoningByModel[apiDefault] ?? null,
    );
    if (apiReasoning) defaultReasoningByAccess.api = apiReasoning;
  }

  return {
    agent: "codex",
    customModelPlaceholder: fallbackPlaceholder,
    defaultModelByAccess: {
      ...(chatgptDefault ? { chatgpt: chatgptDefault } : {}),
      ...(apiDefault ? { api: apiDefault } : {}),
    },
    defaultReasoningByAccess,
    modelsByAccess: {
      chatgpt: chatgptModels,
      api: apiModels,
    },
    defaultReasoningByModel,
    reasoningOptionsByModel,
  };
}

function formatClaudeModelLabel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized === "opus") return "Claude Opus";
  if (normalized === "sonnet") return "Claude Sonnet";
  if (normalized === "haiku") return "Claude Haiku";

  const match = normalized.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-(\d{8}))?$/);
  if (!match) {
    return normalized
      .split(/[-_]+/g)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }

  const family = match[1];
  const major = match[2];
  const minor = match[3];
  return `Claude ${family[0]?.toUpperCase() + family.slice(1)} ${major}.${minor}`;
}

function getClaudeAccessForModel(model: string): AgentModelAccess[] {
  const normalized = model.trim().toLowerCase();
  if (normalized === "opus" || normalized.includes("claude-opus")) {
    return ["max", "api"];
  }
  if (normalized === "haiku" || normalized.includes("claude-haiku")) {
    return ["api"];
  }
  return ["pro", "max", "api"];
}

function toRuntimeModelOption(
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

function resolveClaudeConfiguredModel(
  configuredModel: string | null,
  availableModels: AgentModelOption[],
  family: "sonnet" | "opus" | "haiku",
): string | null {
  if (!configuredModel) return null;
  const normalized = configuredModel.trim().toLowerCase();
  if (availableModels.some((model) => model.id === normalized)) {
    return normalized;
  }
  if (normalized === family) {
    return availableModels.find((model) => model.id.toLowerCase().includes(`claude-${family}`))?.id ?? null;
  }
  return null;
}

function collectClaudeStatsModels(stats: ClaudeStatsCache | null): string[] {
  const entries = Array.isArray(stats?.dailyModelTokens) ? stats.dailyModelTokens : [];
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const entry of [...entries].reverse()) {
    const tokensByModel = toObject(entry.tokensByModel);
    for (const model of Object.keys(tokensByModel)) {
      const normalized = model.trim();
      if (!normalized.startsWith("claude-") || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }

  return ordered;
}

async function readCommandHelp(commands: string[]): Promise<string | null> {
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

async function detectReasoningOptionsFromHelp(commands: string[]): Promise<AgentReasoningOption[]> {
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

async function buildClaudeRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const settings = await readJsonFileIfPresent<ClaudeSettings>(join(homedir(), ".claude", "settings.json"));
  const stats = await readJsonFileIfPresent<ClaudeStatsCache>(join(homedir(), ".claude", "stats-cache.json"));
  const reasoningOptions = await detectReasoningOptionsFromHelp(["claude", "claude-code", "cc"]);
  const discoveredModels = collectClaudeStatsModels(stats);
  const configuredModel = typeof settings?.model === "string" ? settings.model.trim().toLowerCase() : null;

  const availableModels = uniqueModelOptions(discoveredModels.map((model) => {
    return toRuntimeModelOption(
      model,
      `Model discovered from the local Claude Code installation (${model}).`,
      getClaudeAccessForModel(model),
      formatClaudeModelLabel,
    );
  }));

  if (availableModels.length === 0 && !configuredModel) {
    return null;
  }

  const allModels = availableModels.length > 0
    ? availableModels
    : [
        toRuntimeModelOption(
          configuredModel ?? "sonnet",
          "Model configured in the local Claude Code settings.",
          getClaudeAccessForModel(configuredModel ?? "sonnet"),
          formatClaudeModelLabel,
        ),
      ];

  const proModels = allModels.filter((model) => model.access.includes("pro"));
  const maxModels = allModels.filter((model) => model.access.includes("max"));
  const apiModels = allModels.filter((model) => model.access.includes("api"));

  const defaultModelByAccess: Partial<Record<AgentModelAccess, string>> = {};
  const proDefault = resolveClaudeConfiguredModel(configuredModel, proModels, "sonnet") ?? proModels[0]?.id ?? null;
  const maxDefault = resolveClaudeConfiguredModel(configuredModel, maxModels, "opus")
    ?? maxModels.find((model) => model.id.toLowerCase().includes("claude-opus"))?.id
    ?? maxModels[0]?.id
    ?? null;
  const apiDefault = resolveClaudeConfiguredModel(configuredModel, apiModels, "sonnet") ?? apiModels[0]?.id ?? null;

  if (proDefault) defaultModelByAccess.pro = proDefault;
  if (maxDefault) defaultModelByAccess.max = maxDefault;
  if (apiDefault) defaultModelByAccess.api = apiDefault;

  const defaultReasoning = settings?.alwaysThinkingEnabled === true ? "high" : "medium";
  const defaultReasoningByAccess: Partial<Record<AgentModelAccess, string>> = {};
  for (const access of ["pro", "max", "api"] as const) {
    const resolvedDefault = pickRuntimeDefaultReasoning(reasoningOptions, defaultReasoning, defaultReasoning);
    if (resolvedDefault) {
      defaultReasoningByAccess[access] = resolvedDefault;
    }
  }

  return {
    agent: "claude-code",
    customModelPlaceholder: configuredModel || allModels[0]?.id || "",
    defaultModelByAccess,
    defaultReasoningByAccess,
    modelsByAccess: {
      ...(proModels.length > 0 ? { pro: proModels } : {}),
      ...(maxModels.length > 0 ? { max: maxModels } : {}),
      ...(apiModels.length > 0 ? { api: apiModels } : {}),
    },
    ...(reasoningOptions.length > 0
      ? {
          reasoningOptionsByAccess: {
            pro: reasoningOptions,
            max: reasoningOptions,
            api: reasoningOptions,
          },
        }
      : {}),
  };
}

async function collectRecentFiles(rootDir: string, options: RecentFileMatchOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 5;
  const maxFiles = options.maxFiles ?? 24;
  const extensions = new Set((options.extensions ?? []).map((value) => value.toLowerCase()));
  const files: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
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

async function collectRegexMatchesFromRecentFiles(
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

function formatGeminiModelLabel(model: string): string {
  return model
    .trim()
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part[0]?.toUpperCase() + part.slice(1);
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

async function buildGeminiRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const settings = await readJsonFileIfPresent<SimpleAuthSettings>(join(homedir(), ".gemini", "settings.json"));
  const models = await collectRegexMatchesFromRecentFiles(
    join(homedir(), ".gemini"),
    /"(?:model|modelVersion)"\s*:\s*"([^"]+)"/g,
    { extensions: [".json", ".jsonl"], filenamePattern: /\.(json|jsonl)$/i, maxDepth: 6, maxFiles: 24 },
  );

  if (models.length === 0) {
    return null;
  }

  const runtimeModels = uniqueModelOptions(models.map((model) => toRuntimeModelOption(
    model,
    `Model discovered from the local Gemini CLI installation (${model}).`,
    ["oauth", "api"],
    formatGeminiModelLabel,
  )));
  const selectedType = typeof settings?.security?.auth?.selectedType === "string"
    ? settings.security.auth.selectedType.trim().toLowerCase()
    : null;
  const defaultModel = runtimeModels[0]?.id ?? null;

  return {
    agent: "gemini",
    customModelPlaceholder: defaultModel ?? "",
    defaultModelByAccess: {
      ...(defaultModel ? { oauth: defaultModel, api: defaultModel } : {}),
    },
    modelsByAccess: {
      oauth: runtimeModels,
      api: runtimeModels,
    },
    defaultReasoningByAccess: {},
    ...(selectedType?.includes("oauth")
      ? { customModelPlaceholder: defaultModel ?? "" }
      : {}),
  };
}

function formatQwenModelLabel(model: string): string {
  return model
    .trim()
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

async function buildQwenRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const models = await collectRegexMatchesFromRecentFiles(
    join(homedir(), ".qwen"),
    /"(?:model|modelVersion)"\s*:\s*"([^"]+)"/g,
    { extensions: [".json", ".jsonl"], filenamePattern: /\.(json|jsonl)$/i, maxDepth: 7, maxFiles: 24 },
  );

  if (models.length === 0) {
    return null;
  }

  const runtimeModels = uniqueModelOptions(models.map((model) => toRuntimeModelOption(
    model,
    `Model discovered from the local Qwen Code installation (${model}).`,
    ["oauth", "api"],
    formatQwenModelLabel,
  )));
  const defaultModel = runtimeModels[0]?.id ?? null;

  return {
    agent: "qwen-code",
    customModelPlaceholder: defaultModel ?? "",
    defaultModelByAccess: {
      ...(defaultModel ? { oauth: defaultModel, api: defaultModel } : {}),
    },
    modelsByAccess: {
      oauth: runtimeModels,
      api: runtimeModels,
    },
    defaultReasoningByAccess: {},
  };
}

export async function getRuntimeAgentModelCatalog(agent: string): Promise<RuntimeAgentModelCatalog | null> {
  const normalizedAgent = agent.trim().toLowerCase();

  if (normalizedAgent === "codex") {
    const contents = await readTextFileIfPresent(join(homedir(), ".codex", "models_cache.json"));
    if (!contents) return null;

    try {
      const parsed = JSON.parse(contents) as unknown;
      const configuredState = await readCodexConfiguredState();
      return parseCodexRuntimeModelCatalog(
        parsed,
        configuredState.model,
        configuredState.reasoningEffort,
      );
    } catch {
      return null;
    }
  }

  if (normalizedAgent === "claude-code") {
    return buildClaudeRuntimeModelCatalog();
  }

  if (normalizedAgent === "gemini") {
    return buildGeminiRuntimeModelCatalog();
  }

  if (normalizedAgent === "qwen-code") {
    return buildQwenRuntimeModelCatalog();
  }

  return null;
}

export async function getResolvedDefaultAgentModel(
  agent: string,
  preferences?: ModelAccessPreferences | null,
): Promise<string | null> {
  const runtimeCatalog = await getRuntimeAgentModelCatalog(agent);
  const access = resolveAgentModelAccess(agent, preferences);
  return getRuntimeCatalogDefaultModelForAccess(runtimeCatalog, access);
}

export async function getResolvedDefaultAgentReasoningEffort(
  agent: string,
  preferences?: ModelAccessPreferences | null,
  model?: string | null,
): Promise<string | null> {
  const runtimeCatalog = await getRuntimeAgentModelCatalog(agent);
  const access = resolveAgentModelAccess(agent, preferences);
  const resolvedModel = model?.trim()
    || getRuntimeCatalogDefaultModelForAccess(runtimeCatalog, access);
  return getRuntimeCatalogDefaultReasoning(runtimeCatalog, resolvedModel, access);
}
