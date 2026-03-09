import { NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { normalizeAgentName } from "@/lib/agentUtils";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import {
  getKnownAgent,
  getKnownAgentOrderIndex,
  KNOWN_AGENTS,
} from "@/lib/knownAgents";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";
import { getRuntimeAgentModelCatalog } from "@/lib/runtimeAgentModels";
import { hasRustBackend, proxyToRust } from "@/lib/rustBackendProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AgentResponse = {
  name: string;
  label?: string;
  description: string;
  installed: boolean;
  configured: boolean;
  ready: boolean;
  homepage: string | null;
  iconUrl: string | null;
  installHint: string | null;
  installUrl: string | null;
  setupUrl: string | null;
  version: string | null;
  binary: string | null;
  runtimeModelCatalog: RuntimeAgentModelCatalog | null;
};

type BackendAgentResponse = Partial<AgentResponse> & {
  name?: string;
  runtimeModelCatalog?: unknown;
};

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeAgentsPayload(value: unknown): BackendAgentResponse[] {
  if (Array.isArray(value)) {
    return value as BackendAgentResponse[];
  }

  const root = toObject(value);
  if (Array.isArray(root["agents"])) {
    return root["agents"] as BackendAgentResponse[];
  }

  return [];
}

function normalizeRuntimeModelCatalog(value: unknown): RuntimeAgentModelCatalog | null {
  const record = toObject(value);
  return typeof record["agent"] === "string"
    ? value as RuntimeAgentModelCatalog
    : null;
}

function resolveConfiguredState(
  installed: boolean,
  backendConfigured: boolean | undefined,
  backendReady: boolean | undefined,
) {
  if (!installed) {
    return { configured: false, ready: false };
  }

  const configured = backendConfigured !== false;
  const ready = backendReady !== false && configured;
  return { configured, ready };
}

async function loadRuntimeCatalogs() {
  const entries = await Promise.all(
    KNOWN_AGENTS.map(async (agent) => {
      const catalog = await getRuntimeAgentModelCatalog(agent.name);
      return [normalizeAgentName(agent.name), catalog] as const;
    }),
  );

  return new Map(entries);
}

function sortAgents(left: AgentResponse, right: AgentResponse) {
  const leftOrder = getKnownAgentOrderIndex(left.name);
  const rightOrder = getKnownAgentOrderIndex(right.name);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return (left.label ?? left.name).localeCompare(right.label ?? right.name);
}

export async function GET(request: Request): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  if (!hasRustBackend()) {
    return NextResponse.json(
      { error: "Rust backend URL is not configured" },
      { status: 503 },
    );
  }

  let backendResponse: Response;
  try {
    backendResponse = await proxyToRust(request, "/api/agents", {
      headers: await buildForwardedAccessHeaders(request),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach Rust backend" },
      { status: 502 },
    );
  }

  if (!backendResponse.ok) {
    return backendResponse;
  }

  const payload = await backendResponse.json().catch(() => null);
  const backendAgents = normalizeAgentsPayload(payload);
  const runtimeCatalogs = await loadRuntimeCatalogs();
  const merged = new Map<string, AgentResponse>();

  for (const known of KNOWN_AGENTS) {
    merged.set(normalizeAgentName(known.name), {
      name: known.name,
      label: known.label,
      description: known.description,
      installed: false,
      configured: false,
      ready: false,
      homepage: known.homepage,
      iconUrl: known.iconUrl,
      installHint: known.installHint ?? null,
      installUrl: known.installUrl ?? known.homepage,
      setupUrl: known.setupUrl ?? known.homepage,
      version: null,
      binary: null,
      runtimeModelCatalog: runtimeCatalogs.get(normalizeAgentName(known.name)) ?? null,
    });
  }

  for (const entry of backendAgents) {
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      continue;
    }

    const normalizedName = normalizeAgentName(entry.name);
    const known = getKnownAgent(normalizedName);
    const canonicalName = known?.name ?? normalizedName;
    const normalizedCanonical = normalizeAgentName(canonicalName);
    const runtimeModelCatalog = normalizeRuntimeModelCatalog(entry.runtimeModelCatalog)
      ?? runtimeCatalogs.get(normalizedCanonical)
      ?? null;
    const installed = entry.installed !== false;
    const resolvedState = resolveConfiguredState(
      installed,
      entry.configured,
      entry.ready,
    );

    merged.set(normalizedCanonical, {
      name: canonicalName,
      label: known?.label ?? (typeof entry.label === "string" ? entry.label : undefined),
      description: typeof entry.description === "string" && entry.description.trim().length > 0
        ? entry.description
        : known?.description ?? "Agent metadata not available.",
      installed,
      configured: resolvedState.configured,
      ready: resolvedState.ready,
      homepage: typeof entry.homepage === "string" && entry.homepage.trim().length > 0
        ? entry.homepage
        : known?.homepage ?? null,
      iconUrl: typeof entry.iconUrl === "string" && entry.iconUrl.trim().length > 0
        ? entry.iconUrl
        : known?.iconUrl ?? null,
      installHint: known?.installHint ?? null,
      installUrl: known?.installUrl ?? known?.homepage ?? null,
      setupUrl: known?.setupUrl ?? known?.homepage ?? null,
      version: typeof entry.version === "string" && entry.version.trim().length > 0
        ? entry.version
        : null,
      binary: typeof entry.binary === "string" && entry.binary.trim().length > 0
        ? entry.binary
        : null,
      runtimeModelCatalog,
    });
  }

  return NextResponse.json({
    agents: [...merged.values()].sort(sortAgents),
  });
}
