import { readFile } from "node:fs/promises";
import type { DashboardSession } from "@/lib/types";

const LOCAL_HOST_PATTERN = /(?:127\.0\.0\.1|0\.0\.0\.0|localhost)/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const DIRECT_URL_METADATA_KEYS = new Set([
  "previewUrl",
  "devServerUrl",
  "devServerURL",
  "localUrl",
  "url",
]);
const DIRECT_URL_METADATA_PRIORITY: Record<string, number> = {
  devServerUrl: 0,
  devServerURL: 0,
  localUrl: 10,
  previewUrl: 50,
  url: 30,
};

function getBackendUrl(): string {
  return process.env.CONDUCTOR_BACKEND_URL?.trim() ?? "";
}

export interface PreviewSessionContext {
  session: DashboardSession | null;
  candidateUrls: string[];
  error: string | null;
}

type PreviewFetchOptions = {
  headers?: HeadersInit;
};

export async function fetchDashboardSessionForPreview(
  id: string,
  options: PreviewFetchOptions = {},
): Promise<DashboardSession | null> {
  const backendUrl = getBackendUrl();
  if (!backendUrl) {
    throw new Error("Rust backend URL is not configured");
  }

  const target = new URL(`/api/sessions/${encodeURIComponent(id)}`, backendUrl);
  const response = await fetch(target, {
    cache: "no-store",
    headers: options.headers,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch session ${id}: ${response.status}`);
  }

  return response.json() as Promise<DashboardSession>;
}

export async function loadPreviewSessionContext(
  id: string,
  options: PreviewFetchOptions = {},
): Promise<PreviewSessionContext> {
  try {
    const session = await fetchDashboardSessionForPreview(id, options);
    if (!session) {
      return { session: null, candidateUrls: [], error: null };
    }

    return {
      session,
      candidateUrls: await discoverPreviewCandidateUrls(session, options),
      error: null,
    };
  } catch (error) {
    return {
      session: null,
      candidateUrls: [],
      error: error instanceof Error ? error.message : "Failed to load preview session",
    };
  }
}

function normalizeCandidateUrl(value: string): string {
  const trimmed = value.trim().replace(/[),.;]+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "0.0.0.0") {
      parsed.hostname = "127.0.0.1";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function shouldIgnoreCandidateUrl(value: string, backendUrl: string): boolean {
  try {
    const parsed = new URL(value);
    if (backendUrl) {
      const backend = new URL(backendUrl);
      if (parsed.origin === backend.origin) {
        return true;
      }
    }
    return parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

async function extractUrlsFromDevServerLog(logPath: string): Promise<string[]> {
  try {
    const contents = await readFile(logPath, "utf8");
    return extractUrlsFromText(contents);
  } catch {
    return [];
  }
}

function extractUrlsFromText(value: string | null | undefined): string[] {
  const matches = value?.match(URL_PATTERN) ?? [];
  return matches.map(normalizeCandidateUrl);
}

function pushCandidate(
  candidates: Map<string, number>,
  value: string | null | undefined,
  priority: number,
  backendUrl: string,
) {
  if (!value?.trim()) return;
  const normalized = normalizeCandidateUrl(value);
  if (!normalized || shouldIgnoreCandidateUrl(normalized, backendUrl)) {
    return;
  }

  const current = candidates.get(normalized);
  if (current === undefined || priority < current) {
    candidates.set(normalized, priority);
  }
}

async function fetchSessionOutputForPreview(
  id: string,
  options: PreviewFetchOptions = {},
): Promise<string> {
  const backendUrl = getBackendUrl();
  if (!backendUrl) return "";

  try {
    const target = new URL(`/api/sessions/${encodeURIComponent(id)}/output?lines=400`, backendUrl);
    const response = await fetch(target, {
      cache: "no-store",
      headers: options.headers,
    });
    if (!response.ok) {
      return "";
    }
    const payload = await response.json().catch(() => null) as { output?: string } | null;
    return typeof payload?.output === "string" ? payload.output : "";
  } catch {
    return "";
  }
}

export async function discoverPreviewCandidateUrls(
  session: DashboardSession,
  options: PreviewFetchOptions = {},
): Promise<string[]> {
  const backendUrl = getBackendUrl();
  const candidates = new Map<string, number>();

  if (session.pr?.previewUrl?.trim()) {
    pushCandidate(candidates, session.pr.previewUrl, 50, backendUrl);
  }

  if (session.metadata.devServerUrl?.trim()) {
    pushCandidate(candidates, session.metadata.devServerUrl, 0, backendUrl);
  }

  for (const [key, value] of Object.entries(session.metadata)) {
    if (DIRECT_URL_METADATA_KEYS.has(key) && value.trim()) {
      pushCandidate(candidates, value, DIRECT_URL_METADATA_PRIORITY[key] ?? 30, backendUrl);
    }
    for (const candidate of extractUrlsFromText(value)) {
      pushCandidate(candidates, candidate, 60, backendUrl);
    }
  }

  for (const candidate of extractUrlsFromText(session.summary)) {
    pushCandidate(candidates, candidate, 70, backendUrl);
  }

  const devServerLog = session.metadata.devServerLog?.trim();
  if (devServerLog) {
    for (const candidate of await extractUrlsFromDevServerLog(devServerLog)) {
      pushCandidate(candidates, candidate, 40, backendUrl);
    }
  }

  for (const candidate of extractUrlsFromText(await fetchSessionOutputForPreview(session.id, options))) {
    pushCandidate(candidates, candidate, 80, backendUrl);
  }

  return [...candidates.entries()]
    .sort(([left, leftPriority], [right, rightPriority]) => {
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      const leftScore = LOCAL_HOST_PATTERN.test(left) ? 0 : 1;
      const rightScore = LOCAL_HOST_PATTERN.test(right) ? 0 : 1;
      if (leftScore !== rightScore) return leftScore - rightScore;
      return left.localeCompare(right);
    })
    .map(([candidate]) => candidate);
}
