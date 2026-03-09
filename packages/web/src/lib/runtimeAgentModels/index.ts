import {
  resolveAgentModelAccess,
  type ModelAccessPreferences,
} from "@conductor-oss/core/types";
import {
  getRuntimeCatalogDefaultModelForAccess,
  getRuntimeCatalogDefaultReasoning,
  type RuntimeAgentModelCatalog,
} from "../runtimeAgentModelsShared";
import { RUNTIME_MODEL_CATALOG_TTL_MS } from "./types";
import type { RuntimeModelCatalogCacheEntry } from "./types";

import { buildCodexRuntimeModelCatalog, parseCodexRuntimeModelCatalog } from "./codex";
import { buildClaudeRuntimeModelCatalog } from "./claude";
import { buildGeminiRuntimeModelCatalog } from "./gemini";
import { buildAmpRuntimeModelCatalog } from "./amp";
import { buildOpenCodeRuntimeModelCatalog } from "./opencode";
import { buildCopilotRuntimeModelCatalog } from "./copilot";
import { buildDroidRuntimeModelCatalog } from "./droid";
import { buildCursorRuntimeModelCatalog } from "./cursor";
import { buildQwenRuntimeModelCatalog } from "./qwen";
import { buildCcrRuntimeModelCatalog } from "./ccr";

export { parseCodexRuntimeModelCatalog } from "./codex";

const runtimeModelCatalogCache = new Map<string, RuntimeModelCatalogCacheEntry>();
const runtimeModelCatalogInflight = new Map<string, Promise<RuntimeAgentModelCatalog | null>>();

async function loadRuntimeAgentModelCatalog(agent: string): Promise<RuntimeAgentModelCatalog | null> {
  const normalizedAgent = agent.trim().toLowerCase();

  if (normalizedAgent === "codex") {
    return buildCodexRuntimeModelCatalog();
  }

  if (normalizedAgent === "claude-code") {
    return buildClaudeRuntimeModelCatalog();
  }

  if (normalizedAgent === "amp") {
    return buildAmpRuntimeModelCatalog();
  }

  if (normalizedAgent === "cursor-cli") {
    return buildCursorRuntimeModelCatalog();
  }

  if (normalizedAgent === "droid") {
    return buildDroidRuntimeModelCatalog();
  }

  if (normalizedAgent === "gemini") {
    return buildGeminiRuntimeModelCatalog();
  }

  if (normalizedAgent === "github-copilot") {
    return buildCopilotRuntimeModelCatalog();
  }

  if (normalizedAgent === "opencode") {
    return buildOpenCodeRuntimeModelCatalog();
  }

  if (normalizedAgent === "qwen-code") {
    return buildQwenRuntimeModelCatalog();
  }

  if (normalizedAgent === "ccr") {
    return buildCcrRuntimeModelCatalog();
  }

  return null;
}

export async function getRuntimeAgentModelCatalog(agent: string): Promise<RuntimeAgentModelCatalog | null> {
  const normalizedAgent = agent.trim().toLowerCase();
  if (!normalizedAgent) {
    return null;
  }

  const now = Date.now();
  const cached = runtimeModelCatalogCache.get(normalizedAgent);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = runtimeModelCatalogInflight.get(normalizedAgent);
  if (inFlight) {
    return inFlight;
  }

  const promise = loadRuntimeAgentModelCatalog(normalizedAgent)
    .then((value) => {
      runtimeModelCatalogCache.set(normalizedAgent, {
        value,
        expiresAt: Date.now() + RUNTIME_MODEL_CATALOG_TTL_MS,
      });
      return value;
    })
    .finally(() => {
      runtimeModelCatalogInflight.delete(normalizedAgent);
    });

  runtimeModelCatalogInflight.set(normalizedAgent, promise);
  return promise;
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
