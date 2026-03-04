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
      .then((data: Agent[]) => setAgents(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { agents, loading };
}
