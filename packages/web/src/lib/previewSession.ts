import { readFile } from "node:fs/promises";
import { proxyToBridgeDevice } from "@/lib/bridgeApiProxy";
import { requireRustBackendUrl, resolveRustBackendUrl } from "@/lib/backendUrl";
import { decodeBridgeSessionId, decorateBridgeSession } from "@/lib/bridgeSessionIds";
import type { DashboardSession } from "@/lib/types";

const LOCAL_HOST_PATTERN = /(?:127\.0\.0\.1|0\.0\.0\.0|localhost|::1|\[::1\])/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const BARE_LOCAL_URL_PATTERN = /(?<!:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/[^\s"'<>`]*)?/gi;
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
  return resolveRustBackendUrl() ?? "";
}

export interface PreviewSessionContext {
  session: DashboardSession | null;
  candidateUrls: string[];
  error: string | null;
  bridgePreview: BridgePreviewConfig | null;
}

type PreviewFetchOptions = {
  headers?: HeadersInit;
  request?: Request;
};

export interface BridgePreviewConfig {
  bridgeId: string;
  sessionId: string;
  allowedOrigins: string[];
}

function resolveSessionPath(id: string, suffix = ""): string {
  const bridgeSession = decodeBridgeSessionId(id);
  const sessionId = bridgeSession?.sessionId ?? id;
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

async function fetchPreviewResource(
  id: string,
  path: string,
  options: PreviewFetchOptions = {},
): Promise<Response> {
  const bridgeSession = decodeBridgeSessionId(id);
  if (bridgeSession) {
    if (!options.request) {
      throw new Error("Bridge preview lookup requires the incoming request context");
    }

    return proxyToBridgeDevice(options.request, bridgeSession.bridgeId, path, {
      pathOverride: path,
    });
  }

  const backendUrl = requireRustBackendUrl();
  const target = new URL(path, backendUrl);
  return fetch(target, {
    cache: "no-store",
    headers: options.headers,
  });
}

export async function fetchDashboardSessionForPreview(
  id: string,
  options: PreviewFetchOptions = {},
): Promise<DashboardSession | null> {
  const bridgeSession = decodeBridgeSessionId(id);
  const response = await fetchPreviewResource(id, resolveSessionPath(id), options);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch session ${id}: ${response.status}`);
  }

  const session = await response.json() as DashboardSession;
  return bridgeSession ? decorateBridgeSession(session, bridgeSession.bridgeId) : session;
}

export async function loadPreviewSessionContext(
  id: string,
  options: PreviewFetchOptions = {},
): Promise<PreviewSessionContext> {
  try {
    const session = await fetchDashboardSessionForPreview(id, options);
    if (!session) {
      return { session: null, candidateUrls: [], error: null, bridgePreview: null };
    }

    const candidateUrls = await discoverPreviewCandidateUrls(session, options);
    return {
      session,
      candidateUrls,
      error: resolveBridgePreviewWarning(session, candidateUrls),
      bridgePreview: buildBridgePreviewConfig(session, candidateUrls),
    };
  } catch (error) {
    return {
      session: null,
      candidateUrls: [],
      error: error instanceof Error ? error.message : "Failed to load preview session",
      bridgePreview: null,
    };
  }
}

function resolveBridgePreviewWarning(
  session: DashboardSession,
  candidateUrls: string[],
): string | null {
  if (!session.bridgeId?.trim() || candidateUrls.length > 0) {
    return null;
  }

  const previewHints = [
    session.pr?.previewUrl ?? null,
    session.metadata.devServerUrl ?? null,
    session.metadata.devServerURL ?? null,
    session.metadata.localUrl ?? null,
    session.metadata.url ?? null,
    session.summary,
  ];

  const hasLocalHint = previewHints.some((value) => (
    extractUrlsFromText(value).some((candidate) => LOCAL_HOST_PATTERN.test(candidate))
  ));

  if (hasLocalHint) {
    return "Bridge preview could not find a paired-device local dev server URL for this session.";
  }

  return "Bridge preview uses the paired device's local dev server, but this session did not report one.";
}

function buildBridgePreviewConfig(
  session: DashboardSession,
  candidateUrls: string[],
): BridgePreviewConfig | null {
  const bridgeId = session.bridgeId?.trim();
  if (!bridgeId) {
    return null;
  }

  const allowedOrigins = [...new Set(
    candidateUrls
      .filter((candidate) => LOCAL_HOST_PATTERN.test(candidate))
      .map((candidate) => {
        try {
          return new URL(candidate).origin;
        } catch {
          return null;
        }
      })
      .filter((origin): origin is string => Boolean(origin)),
  )];

  if (allowedOrigins.length === 0) {
    return null;
  }

  const bridgeSession = decodeBridgeSessionId(session.id);
  return {
    bridgeId,
    sessionId: bridgeSession?.sessionId ?? session.id,
    allowedOrigins,
  };
}

function normalizeCandidateUrl(value: string): string {
  const trimmed = value.trim().replace(/[),.;]+$/, "");
  const normalizedInput = URL_SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : BARE_LOCAL_URL_PATTERN.test(trimmed)
      ? `http://${trimmed}`
      : trimmed;
  BARE_LOCAL_URL_PATTERN.lastIndex = 0;
  try {
    const parsed = new URL(normalizedInput);
    if (parsed.hostname === "0.0.0.0") {
      parsed.hostname = "127.0.0.1";
    }
    return parsed.toString();
  } catch {
    return normalizedInput;
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
  const matches = [
    ...(value?.match(URL_PATTERN) ?? []),
    ...(value?.match(BARE_LOCAL_URL_PATTERN) ?? []),
  ];
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
  try {
    const response = await fetchPreviewResource(
      id,
      resolveSessionPath(id, "/output?lines=400"),
      options,
    );
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

  const orderedCandidates = [...candidates.entries()]
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

  if (session.bridgeId?.trim()) {
    return orderedCandidates.filter((candidate) => LOCAL_HOST_PATTERN.test(candidate));
  }

  return orderedCandidates;
}
