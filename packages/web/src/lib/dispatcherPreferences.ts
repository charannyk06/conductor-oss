import { normalizeAgentName } from "@/lib/agentUtils";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import type { DashboardSession } from "@/lib/types";

export const DISPATCHER_RUNTIME_AGENT_OPTIONS = [
  "codex",
  "claude-code",
  "gemini",
  "openclaw",
  "letta",
] as const;

export const DISPATCHER_HANDOFF_AGENT_OPTIONS = [
  "codex",
  "claude-code",
  "gemini",
  "cursor-cli",
  "openclaw",
  "pi",
  "letta",
] as const;

const DISPATCHER_RUNTIME_AGENT_SET = new Set<string>(DISPATCHER_RUNTIME_AGENT_OPTIONS);
const DISPATCHER_HANDOFF_AGENT_SET = new Set<string>(DISPATCHER_HANDOFF_AGENT_OPTIONS);

function canonicalDispatcherAgent(value: string | null | undefined): string | null {
  const normalized = normalizeAgentName(value ?? "");
  if (!normalized) return null;
  switch (normalized) {
    case "claude":
    case "claude-code":
    case "claudecode":
      return "claude-code";
    case "cursor":
    case "cursor-agent":
    case "cursor-cli":
      return "cursor-cli";
    case "letta":
    case "letta-code":
      return "letta";
    default:
      return normalized;
  }
}

export function isDispatcherRuntimeAgent(value: string | null | undefined): boolean {
  const canonical = canonicalDispatcherAgent(value);
  return canonical !== null && DISPATCHER_RUNTIME_AGENT_SET.has(canonical);
}

export function isDispatcherHandoffAgent(value: string | null | undefined): boolean {
  const canonical = canonicalDispatcherAgent(value);
  return canonical !== null && DISPATCHER_HANDOFF_AGENT_SET.has(canonical);
}

export function resolveDispatcherRuntimeAgent(
  value: string | null | undefined,
  fallback = "codex",
): string {
  const canonical = canonicalDispatcherAgent(value);
  if (canonical && DISPATCHER_RUNTIME_AGENT_SET.has(canonical)) {
    return canonical;
  }
  return isDispatcherRuntimeAgent(fallback) ? canonicalDispatcherAgent(fallback) ?? "codex" : "codex";
}

export function resolveDispatcherHandoffAgent(
  value: string | null | undefined,
  fallback = "codex",
): string {
  const canonical = canonicalDispatcherAgent(value);
  if (canonical && DISPATCHER_HANDOFF_AGENT_SET.has(canonical)) {
    return canonical;
  }
  return isDispatcherHandoffAgent(fallback) ? canonicalDispatcherAgent(fallback) ?? "codex" : "codex";
}

export function buildNewDispatcherConversationDefaults(defaultAgent: string): {
  runtimeAgent: string;
  implementationAgent: string;
} {
  const implementationAgent = resolveDispatcherHandoffAgent(defaultAgent);
  return {
    runtimeAgent: resolveDispatcherRuntimeAgent(defaultAgent),
    implementationAgent,
  };
}

export function resolveDispatcherSessionAgentName(input: {
  sessionAgent: string | null | undefined;
  legacyMetadataAgent?: string | null | undefined;
}): string | null {
  return canonicalDispatcherAgent(input.sessionAgent) ?? canonicalDispatcherAgent(input.legacyMetadataAgent);
}

export function resolveDispatcherActiveAgentName(input: {
  isDispatcher: boolean;
  sessionAgent: string | null | undefined;
  legacyMetadataAgent?: string | null | undefined;
  repositoryAgent: string | null | undefined;
}): string {
  if (input.isDispatcher) {
    return resolveDispatcherSessionAgentName(input) ?? "codex";
  }
  return canonicalDispatcherAgent(input.repositoryAgent)
    ?? resolveDispatcherSessionAgentName(input)
    ?? "codex";
}

export type DispatcherPreferencePatchScope = {
  projectId: string;
  bridgeId?: string | null;
  threadId: string;
};

export type DispatcherPreferencePatchRequest = DispatcherPreferencePatchScope & {
  dispatcherAgent: string;
  dispatcherModel: string;
  dispatcherReasoningEffort: string;
  implementationAgent: string;
  implementationModel: string;
  implementationReasoningEffort: string;
};

export const DISPATCHER_PREFERENCE_PATCH_TIMEOUT_MS = 15_000;

function formatDispatcherPreferencePatchTimeout(timeoutMs: number): string {
  if (timeoutMs % 1_000 === 0) {
    return `${timeoutMs / 1_000}s`;
  }
  return `${timeoutMs}ms`;
}

export async function sendDispatcherPreferencePatchRequest(
  body: DispatcherPreferencePatchRequest,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<DashboardSession | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DISPATCHER_PREFERENCE_PATCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      withBridgeQuery(
        `/api/projects/${body.projectId}/dispatcher/preferences?threadId=${encodeURIComponent(body.threadId)}`,
        body.bridgeId,
      ),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dispatcherAgent: body.dispatcherAgent,
          dispatcherModel: body.dispatcherModel,
          dispatcherReasoningEffort: body.dispatcherReasoningEffort,
          implementationAgent: body.implementationAgent,
          implementationModel: body.implementationModel,
          implementationReasoningEffort: body.implementationReasoningEffort,
        }),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to update dispatcher preferences");
    }
    return (payload?.thread ?? null) as DashboardSession | null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Updating dispatcher preferences timed out after ${formatDispatcherPreferencePatchTimeout(timeoutMs)}. The backend may be busy.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function dispatcherPreferencePatchScopeKey(
  scope: DispatcherPreferencePatchScope,
): string {
  return JSON.stringify([
    scope.projectId.trim(),
    scope.bridgeId?.trim() ?? "",
    scope.threadId.trim(),
  ]);
}

type SerializedDispatcherPreferencePatchQueueOptions<TPayload, TResult> = {
  getScopeKey: (payload: TPayload) => string;
  send: (payload: TPayload) => Promise<TResult>;
  onSuccess?: (result: TResult, payload: TPayload) => void;
  onError?: (error: unknown, payload: TPayload) => void;
  onPendingChange?: (scopeKey: string, pending: boolean) => void;
};

export function createSerializedDispatcherPreferencePatchQueue<TPayload, TResult>(
  options: SerializedDispatcherPreferencePatchQueueOptions<TPayload, TResult>,
) {
  let disposed = false;
  const scopeStates = new Map<string, { inFlight: boolean; pendingPayload?: TPayload }>();
  const scopePending = new Map<string, boolean>();
  let idleResolvers: Array<() => void> = [];

  const hasPendingWork = () => {
    for (const state of scopeStates.values()) {
      if (state.inFlight || state.pendingPayload !== undefined) {
        return true;
      }
    }
    return false;
  };

  const notifyPending = (scopeKey: string) => {
    const state = scopeStates.get(scopeKey);
    const nextPending = Boolean(state?.inFlight || state?.pendingPayload !== undefined);
    const previousPending = scopePending.get(scopeKey) ?? false;
    if (nextPending === previousPending) {
      return;
    }
    if (nextPending) {
      scopePending.set(scopeKey, true);
    } else {
      scopePending.delete(scopeKey);
    }
    options.onPendingChange?.(scopeKey, nextPending);
  };

  const resolveIdle = () => {
    if (hasPendingWork()) {
      return;
    }
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  };

  const drain = async (scopeKey: string): Promise<void> => {
    if (disposed) {
      resolveIdle();
      return;
    }

    const state = scopeStates.get(scopeKey);
    if (!state || state.inFlight || state.pendingPayload === undefined) {
      resolveIdle();
      return;
    }

    const payload = state.pendingPayload;
    state.pendingPayload = undefined;
    state.inFlight = true;
    notifyPending(scopeKey);

    try {
      const result = await options.send(payload);
      if (!disposed) {
        options.onSuccess?.(result, payload);
      }
    } catch (error) {
      if (!disposed) {
        options.onError?.(error, payload);
      }
    } finally {
      state.inFlight = false;
      if (disposed) {
        scopeStates.clear();
        scopePending.clear();
      } else {
        if (state.pendingPayload !== undefined) {
          void drain(scopeKey);
        } else {
          scopeStates.delete(scopeKey);
          notifyPending(scopeKey);
        }
      }
      resolveIdle();
    }
  };

  return {
    schedule(payload: TPayload) {
      if (disposed) {
        return;
      }
      const scopeKey = options.getScopeKey(payload);
      const state = scopeStates.get(scopeKey) ?? { inFlight: false, pendingPayload: undefined };
      state.pendingPayload = payload;
      scopeStates.set(scopeKey, state);
      notifyPending(scopeKey);
      void drain(scopeKey);
    },
    isPending(scopeKey: string): boolean {
      const state = scopeStates.get(scopeKey);
      return Boolean(state?.inFlight || state?.pendingPayload !== undefined);
    },
    waitForIdle(): Promise<void> {
      if (!hasPendingWork()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
    dispose() {
      disposed = true;
      const scopeKeys = [...scopePending.keys()];
      scopeStates.clear();
      scopePending.clear();
      for (const scopeKey of scopeKeys) {
        options.onPendingChange?.(scopeKey, false);
      }
      resolveIdle();
    },
  };
}
