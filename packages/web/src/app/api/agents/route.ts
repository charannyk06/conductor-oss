import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getRuntimeAgentModelCatalog } from "@/lib/runtimeAgentModels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const AGENTS_RESPONSE_TTL_MS = 30_000;
const AGENT_READINESS_TTL_MS = 60_000;
const AGENT_READY_CHECK_TIMEOUT_MS = 500;

type AgentPayload = {
  name?: unknown;
  binary?: unknown;
  ready?: unknown;
  installed?: unknown;
  runtimeModelCatalog?: unknown;
  [key: string]: unknown;
};

type CachedResponse = {
  body: unknown;
  status: number;
  expiresAt: number;
};

type CachedReadiness = {
  ready: boolean;
  installed: boolean;
  expiresAt: number;
};

let cachedAgentsResponse: CachedResponse | null = null;
let inFlightAgentsResponse: Promise<CachedResponse> | null = null;
const readinessCache = new Map<string, CachedReadiness>();

function normalizeAgentsPayload(payload: unknown): AgentPayload[] {
  if (Array.isArray(payload)) {
    return payload as AgentPayload[];
  }

  if (
    payload
    && typeof payload === "object"
    && "agents" in payload
    && Array.isArray((payload as { agents?: unknown }).agents)
  ) {
    return (payload as { agents: AgentPayload[] }).agents;
  }

  return [];
}

function resolveBackendUrl(): string {
  const explicit = process.env.CONDUCTOR_BACKEND_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const port = process.env.CONDUCTOR_BACKEND_PORT?.trim() || "4748";
  return `http://127.0.0.1:${port}`;
}

const ALLOWED_AGENT_BINARIES = new Set([
  "claude",
  "codex",
  "gemini",
  "gh",
  "opencode",
  "qwen",
  "aider",
  "cursor",
]);

function isSafeBinary(binary: string): boolean {
  const basename = binary.split("/").pop()?.split("\\").pop() ?? "";
  return ALLOWED_AGENT_BINARIES.has(basename);
}

function resolveVersionArgs(agentName: string): string[] {
  switch (agentName) {
    case "opencode":
      return ["version"];
    default:
      return ["--version"];
  }
}

async function resolveAgentReadiness(agent: AgentPayload): Promise<{ ready: boolean; installed: boolean }> {
  const name = typeof agent.name === "string" ? agent.name.trim() : "";
  const binary = typeof agent.binary === "string" ? agent.binary.trim() : "";

  if (!name || !binary) {
    const ready = Boolean(agent.ready ?? agent.installed ?? false);
    return { ready, installed: ready };
  }

  if (!isSafeBinary(binary)) {
    return { ready: false, installed: false };
  }

  const cacheKey = `${name}:${binary}`;
  const now = Date.now();
  const cached = readinessCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ready: cached.ready, installed: cached.installed };
  }

  let ready = false;
  try {
    await execFileAsync(binary, resolveVersionArgs(name), {
      encoding: "utf8",
      timeout: AGENT_READY_CHECK_TIMEOUT_MS,
    });
    ready = true;
  } catch {
    ready = false;
  }

  const next = {
    ready,
    installed: ready,
    expiresAt: now + AGENT_READINESS_TTL_MS,
  };
  readinessCache.set(cacheKey, next);
  return { ready: next.ready, installed: next.installed };
}

async function buildAgentsResponse(): Promise<CachedResponse> {
  const backendUrl = resolveBackendUrl();

  let response: Response;
  response = await fetch(`${backendUrl}/api/agents`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      body: payload ?? { error: `Failed to fetch agents: ${response.status}` },
      status: response.status,
      expiresAt: Date.now() + 5_000,
    };
  }

  const agents = normalizeAgentsPayload(payload);
  const enrichedAgents = await Promise.all(agents.map(async (agent) => {
    const name = typeof agent.name === "string" ? agent.name.trim() : "";
    const { ready, installed } = await resolveAgentReadiness(agent);
    const runtimeModelCatalog = ready && name ? await getRuntimeAgentModelCatalog(name) : null;
    return {
      ...agent,
      ready,
      installed,
      runtimeModelCatalog,
    };
  }));

  if (Array.isArray(payload)) {
    return {
      body: enrichedAgents,
      status: response.status,
      expiresAt: Date.now() + AGENTS_RESPONSE_TTL_MS,
    };
  }

  if (payload && typeof payload === "object") {
    return {
      body: {
        ...(payload as Record<string, unknown>),
        agents: enrichedAgents,
      },
      status: response.status,
      expiresAt: Date.now() + AGENTS_RESPONSE_TTL_MS,
    };
  }

  return {
    body: { agents: enrichedAgents },
    status: response.status,
    expiresAt: Date.now() + AGENTS_RESPONSE_TTL_MS,
  };
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  if (cachedAgentsResponse && cachedAgentsResponse.expiresAt > now) {
    return NextResponse.json(cachedAgentsResponse.body, { status: cachedAgentsResponse.status });
  }

  if (!inFlightAgentsResponse) {
    inFlightAgentsResponse = buildAgentsResponse()
      .then((result) => {
        cachedAgentsResponse = result;
        return result;
      })
      .finally(() => {
        inFlightAgentsResponse = null;
      });
  }

  if (cachedAgentsResponse) {
    return NextResponse.json(cachedAgentsResponse.body, {
      status: cachedAgentsResponse.status,
      headers: { "x-conductor-cache": "stale" },
    });
  }

  try {
    const response = await inFlightAgentsResponse;
    return NextResponse.json(response.body, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to reach agent backend",
      },
      { status: 502 },
    );
  }
}
