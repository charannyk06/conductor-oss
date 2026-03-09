import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModelAccess } from "@conductor-oss/core/types";
import type {
  RuntimeAgentModelContext,
  RuntimeAgentModelCatalog,
} from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  collectRecentFiles,
  extractQuotedChoices,
  formatGenericModelLabel,
  normalizeTokenLimit,
  readCommandHelp,
  readTextFileIfPresent,
} from "./helpers";

async function collectCopilotObservedModelContexts(): Promise<Record<string, RuntimeAgentModelContext>> {
  const sessionFiles = await collectRecentFiles(join(homedir(), ".copilot", "session-state"), {
    extensions: [".jsonl"],
    filenamePattern: /^events\.jsonl$/i,
    maxDepth: 3,
    maxFiles: 16,
    maxDirectories: 48,
  });
  const processLogs = await collectRecentFiles(join(homedir(), ".copilot", "logs"), {
    filenamePattern: /^process-.*\.log$/i,
    maxDepth: 1,
    maxFiles: 16,
    maxDirectories: 4,
  });

  const logSnapshots = (await Promise.all(processLogs.map(async (path) => {
    const contents = await readTextFileIfPresent(path);
    if (!contents) return null;

    const matches = Array.from(contents.matchAll(/Utilization\s+\d+(?:\.\d+)?%\s+\((\d+)\/(\d+)\s+tokens\)/gi));
    const lastMatch = matches[matches.length - 1];
    const maxTokens = normalizeTokenLimit(lastMatch?.[2]);
    if (maxTokens === null) {
      return null;
    }

    try {
      const details = await stat(path);
      return { path, mtimeMs: details.mtimeMs, maxTokens };
    } catch {
      return null;
    }
  }))).filter((entry): entry is { path: string; mtimeMs: number; maxTokens: number } => Boolean(entry));

  const contexts: Record<string, RuntimeAgentModelContext> = {};

  for (const sessionFile of sessionFiles) {
    const contents = await readTextFileIfPresent(sessionFile);
    if (!contents) continue;

    const lines = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let modelId: string | null = null;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { type?: unknown; data?: Record<string, unknown> };
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "session.model_change") {
          const nextModel = typeof parsed.data?.newModel === "string" ? parsed.data.newModel.trim() : "";
          if (nextModel) {
            modelId = nextModel;
          }
        }
        if (type === "session.shutdown") {
          const currentModel = typeof parsed.data?.currentModel === "string" ? parsed.data.currentModel.trim() : "";
          if (currentModel) {
            modelId = currentModel;
          }
        }
      } catch {
        // Ignore malformed lines from partially written logs.
      }
    }

    if (!modelId) continue;

    let sessionMtimeMs = 0;
    try {
      sessionMtimeMs = (await stat(sessionFile)).mtimeMs;
    } catch {
      continue;
    }

    const nearestLog = logSnapshots
      .map((entry) => ({ ...entry, deltaMs: Math.abs(entry.mtimeMs - sessionMtimeMs) }))
      .filter((entry) => entry.deltaMs <= 15 * 60 * 1_000)
      .sort((left, right) => left.deltaMs - right.deltaMs)[0];

    if (!nearestLog) continue;

    contexts[modelId] = {
      maxTokens: nearestLog.maxTokens,
      source: "copilot_process_log",
      note: "Observed from the local GitHub Copilot session logs.",
    };
  }

  return contexts;
}

export async function buildCopilotRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const help = await readCommandHelp(["copilot", "github-copilot", "gh-copilot"]);
  if (!help) {
    return null;
  }

  const modelIds = extractQuotedChoices(help, "--model <model>");
  if (modelIds.length === 0) {
    return null;
  }

  const models = modelIds.map((modelId) => ({
    id: modelId,
    label: formatGenericModelLabel(modelId),
    description: `Model exposed by the local GitHub Copilot CLI (${modelId}).`,
    access: ["default"] as AgentModelAccess[],
  }));
  const defaultModel = modelIds.includes("gpt-5.4") ? "gpt-5.4" : modelIds[0] ?? null;
  const modelContextById = await collectCopilotObservedModelContexts();

  return buildDefaultAccessRuntimeCatalog("github-copilot", models, {
    customModelPlaceholder: defaultModel,
    defaultModel,
    modelContextById,
  });
}
