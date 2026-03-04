"use client";

import { useEffect, useRef, useState } from "react";

interface Agent {
  name: string;
  description: string;
  [key: string]: unknown;
}

interface UseAgentsReturn {
  agents: Agent[];
  loading: boolean;
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

export function useAgents(): UseAgentsReturn {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch("/api/agents")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
        return res.json();
      })
      .then((data: unknown) => setAgents(normalizeAgentsPayload(data)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { agents, loading };
}
