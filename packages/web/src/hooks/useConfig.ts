"use client";

import { useCallback, useEffect, useState } from "react";
import { withBridgeQuery } from "@/lib/bridgeQuery";

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
  refresh: () => Promise<void>;
}

interface UseConfigOptions {
  enabled?: boolean;
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
  const [projects, setProjects] = useState<ConfigProject[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    if (!enabled) {
      setProjects([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(withBridgeQuery("/api/config", bridgeId));
      const payload = (await res.json().catch(() => null)) as
        | { error?: string; reason?: string }
        | unknown;
      if (!res.ok) {
        const message = typeof payload === "object" && payload !== null
          ? ((payload as { error?: string; reason?: string }).error
            ?? (payload as { error?: string; reason?: string }).reason)
          : null;
        throw new Error(message ?? `Failed to fetch config: ${res.status}`);
      }
      setProjects(normalizeProjects(payload));
      setError(null);
    } catch (err) {
      setProjects([]);
      setError(err instanceof Error ? err.message : "Failed to fetch config");
    } finally {
      setLoading(false);
    }
  }, [bridgeId, enabled]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  return { projects, loading: enabled ? loading : false, error: enabled ? error : null, refresh: fetchConfig };
}
