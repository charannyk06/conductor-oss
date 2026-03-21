"use client";

import { useEffect, useState } from "react";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { normalizeBridgeId } from "@/lib/bridgeSessionIds";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";

export interface Agent {
  name: string;
  label?: string;
  description: string;
  installed?: boolean;
  configured?: boolean;
  ready?: boolean;
  binary?: string;
  model?: string;
  homepage?: string;
  iconUrl?: string;
  installHint?: string | null;
  installUrl?: string | null;
  setupUrl?: string | null;
  version?: string | null;
  runtimeModelCatalog?: RuntimeAgentModelCatalog | null;
}

interface UseAgentsReturn {
  agents: Agent[];
  loading: boolean;
}

type AgentsStoreSnapshot = {
  agents: Agent[];
  loading: boolean;
};

interface UseAgentsOptions {
  enabled?: boolean;
}

type AgentsStoreState = {
  agents: Agent[];
  loading: boolean;
  lastFetchedAt: number;
  inFlight: Promise<void> | null;
  retryTimeout: number | null;
};

const AGENTS_STALE_AFTER_MS = 30_000;
const AGENTS_RETRY_DELAY_MS = 10_000;
const LOCAL_SCOPE_KEY = "local";

const listenersByScope = new Map<string, Set<() => void>>();
const storesByScope = new Map<string, AgentsStoreState>();

function resolveScopeKey(bridgeId?: string | null): string {
  return normalizeBridgeId(bridgeId) ?? LOCAL_SCOPE_KEY;
}

function getStore(scopeKey: string): AgentsStoreState {
  let store = storesByScope.get(scopeKey);
  if (!store) {
    store = {
      agents: [],
      loading: true,
      lastFetchedAt: 0,
      inFlight: null,
      retryTimeout: null,
    };
    storesByScope.set(scopeKey, store);
  }
  return store;
}

function getListeners(scopeKey: string): Set<() => void> {
  let listeners = listenersByScope.get(scopeKey);
  if (!listeners) {
    listeners = new Set();
    listenersByScope.set(scopeKey, listeners);
  }
  return listeners;
}

function normalizeAgentsPayload(payload: unknown): Agent[] {
  if (Array.isArray(payload)) return payload as Agent[];

  if (
    payload &&
    typeof payload === "object" &&
    "agents" in payload &&
    Array.isArray((payload as { agents?: unknown }).agents)
  ) {
    return (payload as { agents: Agent[] }).agents;
  }

  return [];
}

function emitChange(scopeKey: string) {
  for (const listener of getListeners(scopeKey)) {
    listener();
  }
}

function currentSnapshot(scopeKey: string): AgentsStoreSnapshot {
  const store = getStore(scopeKey);
  return {
    agents: store.agents,
    loading: store.loading,
  };
}

function isStoreFresh(scopeKey: string) {
  const store = getStore(scopeKey);
  return store.agents.length > 0 && Date.now() - store.lastFetchedAt < AGENTS_STALE_AFTER_MS;
}

function scheduleRetry(scopeKey: string, bridgeId?: string | null) {
  const store = getStore(scopeKey);
  if (store.retryTimeout !== null) return;
  store.retryTimeout = window.setTimeout(() => {
    const currentStore = getStore(scopeKey);
    currentStore.retryTimeout = null;
    void refreshAgents(scopeKey, bridgeId, true);
  }, AGENTS_RETRY_DELAY_MS);
}

async function refreshAgents(scopeKey: string, bridgeId?: string | null, force = false): Promise<void> {
  const store = getStore(scopeKey);
  if (!force && isStoreFresh(scopeKey)) {
    if (store.loading) {
      store.loading = false;
      emitChange(scopeKey);
    }
    return;
  }

  if (store.inFlight) {
    return store.inFlight;
  }

  store.loading = true;
  emitChange(scopeKey);

  store.inFlight = (async () => {
    try {
      const res = await fetch(withBridgeQuery("/api/agents", bridgeId), { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
      const data = (await res.json()) as unknown;
      const nextAgents = normalizeAgentsPayload(data);
      if (nextAgents.length > 0) {
        store.agents = nextAgents;
        store.lastFetchedAt = Date.now();
        if (store.retryTimeout !== null) {
          window.clearTimeout(store.retryTimeout);
          store.retryTimeout = null;
        }
      } else {
        scheduleRetry(scopeKey, bridgeId);
      }
    } catch {
      scheduleRetry(scopeKey, bridgeId);
    } finally {
      store.loading = false;
      store.inFlight = null;
      emitChange(scopeKey);
    }
  })();

  return store.inFlight;
}

export function useAgents(bridgeId?: string | null, options?: UseAgentsOptions): UseAgentsReturn {
  const enabled = options?.enabled ?? true;
  const scopeKey = resolveScopeKey(bridgeId);
  const [snapshot, setSnapshot] = useState<AgentsStoreSnapshot>({ agents: [], loading: enabled });

  useEffect(() => {
    if (!enabled) {
      setSnapshot({ agents: [], loading: false });
      return undefined;
    }

    const applySnapshot = () => setSnapshot(currentSnapshot(scopeKey));
    getListeners(scopeKey).add(applySnapshot);
    applySnapshot();
    void refreshAgents(scopeKey, bridgeId);

    const handleWindowFocus = () => {
      if (!isStoreFresh(scopeKey)) {
        void refreshAgents(scopeKey, bridgeId, true);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !isStoreFresh(scopeKey)) {
        void refreshAgents(scopeKey, bridgeId, true);
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      getListeners(scopeKey).delete(applySnapshot);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [bridgeId, enabled, scopeKey]);

  return enabled ? snapshot : { agents: [], loading: false };
}
