"use client";

import { useEffect, useState } from "react";
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

const AGENTS_STALE_AFTER_MS = 30_000;
const AGENTS_RETRY_DELAY_MS = 10_000;

const listeners = new Set<() => void>();
let storeAgents: Agent[] = [];
let storeLoading = true;
let storeLastFetchedAt = 0;
let storeInFlight: Promise<void> | null = null;
let storeRetryTimeout: number | null = null;

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

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function currentSnapshot(): AgentsStoreSnapshot {
  return {
    agents: storeAgents,
    loading: storeLoading,
  };
}

function isStoreFresh() {
  return storeAgents.length > 0 && Date.now() - storeLastFetchedAt < AGENTS_STALE_AFTER_MS;
}

function scheduleRetry() {
  if (storeRetryTimeout !== null) return;
  storeRetryTimeout = window.setTimeout(() => {
    storeRetryTimeout = null;
    void refreshAgents(true);
  }, AGENTS_RETRY_DELAY_MS);
}

async function refreshAgents(force = false): Promise<void> {
  if (!force && isStoreFresh()) {
    if (storeLoading) {
      storeLoading = false;
      emitChange();
    }
    return;
  }

  if (storeInFlight) {
    return storeInFlight;
  }

  storeLoading = true;
  emitChange();

  storeInFlight = (async () => {
    try {
      const res = await fetch("/api/agents", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
      const data = (await res.json()) as unknown;
      const nextAgents = normalizeAgentsPayload(data);
      if (nextAgents.length > 0) {
        storeAgents = nextAgents;
        storeLastFetchedAt = Date.now();
        if (storeRetryTimeout !== null) {
          window.clearTimeout(storeRetryTimeout);
          storeRetryTimeout = null;
        }
      } else {
        scheduleRetry();
      }
    } catch {
      scheduleRetry();
    } finally {
      storeLoading = false;
      storeInFlight = null;
      emitChange();
    }
  })();

  return storeInFlight;
}

export function useAgents(): UseAgentsReturn {
  const [snapshot, setSnapshot] = useState<AgentsStoreSnapshot>(() => currentSnapshot());

  useEffect(() => {
    const applySnapshot = () => setSnapshot(currentSnapshot());
    listeners.add(applySnapshot);
    applySnapshot();
    void refreshAgents();

    const handleWindowFocus = () => {
      if (!isStoreFresh()) {
        void refreshAgents(true);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !isStoreFresh()) {
        void refreshAgents(true);
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      listeners.delete(applySnapshot);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return snapshot;
}
