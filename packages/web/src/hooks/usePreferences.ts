"use client";

import { useCallback, useEffect, useState } from "react";
import { withBridgeQuery } from "@/lib/bridgeQuery";

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

interface UsePreferencesOptions {
  enabled?: boolean;
}

export function usePreferences(
  bridgeId?: string | null,
  options?: UsePreferencesOptions,
): UsePreferencesReturn {
  const enabled = options?.enabled ?? true;
  const [preferences, setPreferences] = useState<UserPreferencesResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const fetchPreferences = useCallback(async () => {
    if (!enabled) {
      setPreferences(null);
      setError(null);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(withBridgeQuery("/api/preferences", bridgeId));
      const data = (await res.json().catch(() => null)) as
        | { preferences?: unknown; error?: string; reason?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? data?.reason ?? `Failed to load preferences: ${res.status}`);
      }
      setPreferences(normalizePreferences(data?.preferences));
      setError(null);
    } catch (err) {
      setPreferences(null);
      setError(err instanceof Error ? err.message : "Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }, [bridgeId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void fetchPreferences();
  }, [enabled, fetchPreferences]);

  return {
    preferences: enabled ? preferences : null,
    loading: enabled ? loading : false,
    error: enabled ? error : null,
    refresh: fetchPreferences,
  };
}
