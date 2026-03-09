"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UserPreferencesResponse {
  onboardingAcknowledged: boolean;
  codingAgent: string;
  ide: string;
  markdownEditor: string;
  markdownEditorPath: string;
  notifications: {
    soundEnabled: boolean;
    soundFile: string | null;
  };
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizePreferences(value: unknown): UserPreferencesResponse {
  const payload = toObject(value);
  const notifications = toObject(payload["notifications"]);
  const soundFileRaw = notifications["soundFile"];

  return {
    onboardingAcknowledged: payload["onboardingAcknowledged"] === true,
    codingAgent: typeof payload["codingAgent"] === "string" && payload["codingAgent"].trim().length > 0
      ? payload["codingAgent"].trim()
      : "claude-code",
    ide: typeof payload["ide"] === "string" && payload["ide"].trim().length > 0
      ? payload["ide"].trim()
      : "vscode",
    markdownEditor: typeof payload["markdownEditor"] === "string" && payload["markdownEditor"].trim().length > 0
      ? payload["markdownEditor"].trim()
      : "obsidian",
    markdownEditorPath: typeof payload["markdownEditorPath"] === "string"
      ? payload["markdownEditorPath"].trim()
      : "",
    notifications: {
      soundEnabled: notifications["soundEnabled"] !== false,
      soundFile: soundFileRaw === null
        ? null
        : typeof soundFileRaw === "string" && soundFileRaw.trim().length > 0
          ? soundFileRaw.trim()
          : "abstract-sound-4",
    },
  };
}

interface UsePreferencesReturn {
  preferences: UserPreferencesResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePreferences(): UsePreferencesReturn {
  const [preferences, setPreferences] = useState<UserPreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchPreferences = useCallback(async () => {
    try {
      const res = await fetch("/api/preferences");
      const data = (await res.json().catch(() => null)) as
        | { preferences?: unknown; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to load preferences: ${res.status}`);
      }
      setPreferences(normalizePreferences(data?.preferences));
      setError(null);
    } catch (err) {
      setPreferences(null);
      setError(err instanceof Error ? err.message : "Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void fetchPreferences();
  }, [fetchPreferences]);

  return { preferences, loading, error, refresh: fetchPreferences };
}
