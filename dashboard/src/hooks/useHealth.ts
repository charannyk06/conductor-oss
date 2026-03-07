import { useState, useEffect } from "react";
import { api, type HealthResponse, type SessionHealth } from "@/lib/api";

export function useHealth(intervalMs = 5000) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessionHealth, setSessionHealth] = useState<SessionHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const [h, sh] = await Promise.all([api.health(), api.sessionHealth()]);
        setHealth(h);
        setSessionHealth(sh);
        setError(null);
      } catch (e) {
        setError("Server unreachable");
      }
    };

    fetchHealth();
    const timer = setInterval(fetchHealth, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return { health, sessionHealth, error };
}
