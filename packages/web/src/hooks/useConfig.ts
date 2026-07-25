"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { normalizeBridgeId } from "@/lib/bridgeSessionIds";
import { isTransientRequestStatus, requestRetryDelayMs } from "@/lib/requestRetry";

export interface ConfigProject {
  id: string;
  repo: string | null;
  path: string | null;
  iconUrl: string | null;
  boardDir?: string | null;
  boardFile?: string | null;
  description: string | null;
  defaultBranch: string;
  agent: string;
  agentPermissions: string | null;
  agentModel: string | null;
  agentReasoningEffort: string | null;
}

interface UseConfigReturn {
  projects: ConfigProject[];
  loading: boolean;
  error: string | null;
  recovering: boolean;
  refresh: () => Promise<void>;
}

interface UseConfigOptions {
  enabled?: boolean;
}

class ConfigRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ConfigRequestError";
    this.retryable = retryable;
  }
}

function normalizeProject(
  id: string,
  raw: Record<string, unknown> | null,
): ConfigProject {
  return {
    id,
    repo: typeof raw?.["repo"] === "string" ? raw["repo"] : null,
    path: typeof raw?.["path"] === "string" ? raw["path"] : null,
    iconUrl: typeof raw?.["iconUrl"] === "string" ? raw["iconUrl"] : null,
    boardDir: typeof raw?.["boardDir"] === "string" ? raw["boardDir"] : null,
    boardFile: typeof raw?.["boardFile"] === "string" ? raw["boardFile"] : null,
    description: typeof raw?.["description"] === "string" ? raw["description"] : null,
    defaultBranch: typeof raw?.["defaultBranch"] === "string" && raw["defaultBranch"].trim().length > 0
      ? raw["defaultBranch"]
      : "main",
    agent: typeof raw?.["agent"] === "string" && raw["agent"].trim().length > 0
      ? raw["agent"]
      : "claude-code",
    agentPermissions: typeof raw?.["agentPermissions"] === "string" && raw["agentPermissions"].trim().length > 0
      ? raw["agentPermissions"]
      : null,
    agentModel: typeof raw?.["agentModel"] === "string" && raw["agentModel"].trim().length > 0
      ? raw["agentModel"]
      : null,
    agentReasoningEffort: typeof raw?.["agentReasoningEffort"] === "string" && raw["agentReasoningEffort"].trim().length > 0
      ? raw["agentReasoningEffort"]
      : null,
  };
}

function normalizeProjects(payload: unknown): ConfigProject[] {
  if (!payload || typeof payload !== "object") return [];

  const projectsPayload = (payload as { projects?: unknown }).projects;
  if (!projectsPayload) return [];

  if (Array.isArray(projectsPayload)) {
    return projectsPayload
      .map((item, index) => {
        if (!item || typeof item !== "object") {
          return normalizeProject(`project-${index + 1}`, null);
        }
        const raw = item as Record<string, unknown>;
        const id = typeof raw["id"] === "string" && raw["id"].trim().length > 0
          ? raw["id"]
          : `project-${index + 1}`;
        return normalizeProject(id, raw);
      });
  }

  if (typeof projectsPayload === "object") {
    return Object.entries(projectsPayload as Record<string, unknown>)
      .map(([id, item]) => normalizeProject(
        id,
        item && typeof item === "object" ? (item as Record<string, unknown>) : null,
      ));
  }

  return [];
}

export function useConfig(bridgeId?: string | null, options?: UseConfigOptions): UseConfigReturn {
  const enabled = options?.enabled ?? true;
  const scopeKey = normalizeBridgeId(bridgeId) ?? "local";
  const [projects, setProjects] = useState<ConfigProject[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const activeScopeRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const fetchConfigRef = useRef<() => Promise<void>>(async () => {});

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    if (!enabled || retryTimerRef.current !== null) return;
    setRecovering(true);
    const failedAttempt = retryAttemptRef.current;
    retryAttemptRef.current += 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void fetchConfigRef.current();
    }, requestRetryDelayMs(failedAttempt));
  }, [enabled]);

  const fetchConfig = useCallback(async () => {
    if (!enabled) {
      setProjects([]);
      setError(null);
      setRecovering(false);
      setLoading(false);
      return;
    }

    clearRetryTimer();
    const requestEpoch = ++requestEpochRef.current;
    setLoading(true);
    try {
      const res = await fetch(withBridgeQuery("/api/config", bridgeId), { cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as
        | { error?: string; reason?: string }
        | unknown;
      if (!res.ok) {
        const message = typeof payload === "object" && payload !== null
          ? ((payload as { error?: string; reason?: string }).error
            ?? (payload as { error?: string; reason?: string }).reason)
          : null;
        throw new ConfigRequestError(
          message ?? `Failed to fetch config: ${res.status}`,
          isTransientRequestStatus(res.status),
        );
      }
      if (requestEpoch !== requestEpochRef.current) return;
      setProjects(normalizeProjects(payload));
      setError(null);
      setRecovering(false);
      retryAttemptRef.current = 0;
    } catch (err) {
      if (requestEpoch !== requestEpochRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to fetch config");
      if (!(err instanceof ConfigRequestError) || err.retryable) {
        scheduleRetry();
      } else {
        setRecovering(false);
      }
    } finally {
      if (requestEpoch === requestEpochRef.current) {
        setLoading(false);
      }
    }
  }, [bridgeId, clearRetryTimer, enabled, scheduleRetry]);

  fetchConfigRef.current = fetchConfig;

  useEffect(() => {
    const scopeChanged = activeScopeRef.current !== scopeKey;
    activeScopeRef.current = scopeKey;
    requestEpochRef.current += 1;
    clearRetryTimer();
    retryAttemptRef.current = 0;
    if (scopeChanged || !enabled) {
      setProjects([]);
      setError(null);
      setRecovering(false);
    }

    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    void fetchConfig();

    const refreshVisibleConfig = () => {
      if (document.visibilityState === "visible") {
        void fetchConfigRef.current();
      }
    };
    window.addEventListener("focus", refreshVisibleConfig);
    document.addEventListener("visibilitychange", refreshVisibleConfig);

    return () => {
      requestEpochRef.current += 1;
      clearRetryTimer();
      window.removeEventListener("focus", refreshVisibleConfig);
      document.removeEventListener("visibilitychange", refreshVisibleConfig);
    };
  }, [clearRetryTimer, enabled, fetchConfig, scopeKey]);

  return {
    projects,
    loading: enabled ? loading : false,
    error: enabled ? error : null,
    recovering: enabled ? recovering : false,
    refresh: fetchConfig,
  };
}
