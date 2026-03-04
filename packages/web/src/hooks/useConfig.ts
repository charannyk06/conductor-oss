"use client";

import { useEffect, useRef, useState } from "react";

interface Config {
  [key: string]: unknown;
}

interface UseConfigReturn {
  config: Config | null;
  loading: boolean;
}

export function useConfig(): UseConfigReturn {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch("/api/config")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
        return res.json();
      })
      .then((data: Config) => setConfig(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { config, loading };
}
