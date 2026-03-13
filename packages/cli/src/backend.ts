type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface BackendSession {
  id: string;
  projectId: string;
  status: string;
  activity: string | null;
  branch: string | null;
  issueId: string | null;
  summary?: string | null;
  createdAt: string;
  lastActivityAt: string;
  metadata: Record<string, string>;
  workspacePath?: string | null;
  agent?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface BackendProject {
  id: string;
  name?: string | null;
  path?: string;
}

export interface ConfigProject {
  id: string;
  description?: string | null;
  path?: string;
  repo?: string | null;
  defaultBranch?: string | null;
  agent?: string | null;
}

export interface ConfigResponse {
  projects: ConfigProject[];
}

export interface SessionsResponse {
  sessions: BackendSession[];
  stats: {
    totalSessions: number;
    workingSessions: number;
    openPRs: number;
    needsAttention: number;
  };
}

export interface SessionResponse {
  session: BackendSession;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime_secs: number;
  executors: number;
  event_subscribers: number;
  queue_depth: number;
  launching_sessions: number;
  recovering_sessions: number;
  detached_sessions: number;
}

export interface SessionHealthMetric {
  id: string;
  projectId: string;
  status: string;
  activity: string | null;
  health: string;
  ageMs: number;
  idleMs: number;
  createdAt: string;
  lastActivityAt: string;
  hasRuntime: boolean;
  recoveryState?: string | null;
  detachedPid?: string | null;
  hasPR: boolean;
}

export interface SessionHealthResponse {
  metrics: SessionHealthMetric[];
  summary: {
    total: number;
    healthy: number;
    pending: number;
    warning: number;
    critical: number;
  };
}

export interface CleanupResponse {
  killed: string[];
  skipped: string[];
  errors: Array<{
    sessionId: string;
    error: string;
  }>;
}

export interface TaskGraphResponse {
  taskId: string;
  parentTaskId: string | null;
  childrenTaskIds: string[];
  attempts: Array<{
    attemptId: string;
    sessionId: string;
    status: string;
    agent?: string;
    model?: string;
    branch?: string | null;
  }>;
}

let cachedBackendBaseUrl: string | null = null;

function getConfiguredBackendUrl(): string | null {
  const explicitUrl = process.env["CONDUCTOR_BACKEND_URL"]?.trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/, "");
  }

  const devPort = process.env["CONDUCTOR_DEV_BACKEND_PORT"]?.trim();
  if (devPort) {
    return `http://127.0.0.1:${devPort}`;
  }

  const prodPort = process.env["CONDUCTOR_PROD_BACKEND_PORT"]?.trim();
  if (prodPort) {
    return `http://127.0.0.1:${prodPort}`;
  }

  const configuredPort = process.env["CONDUCTOR_BACKEND_PORT"]?.trim();
  if (configuredPort) {
    return `http://127.0.0.1:${configuredPort}`;
  }

  return null;
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveBackendBaseUrl(): Promise<string> {
  if (cachedBackendBaseUrl) {
    return cachedBackendBaseUrl;
  }

  const configured = getConfiguredBackendUrl();
  if (configured) {
    cachedBackendBaseUrl = configured;
    return configured;
  }

  const candidates = [
    process.env["CONDUCTOR_DEV_BACKEND_PORT"]?.trim(),
    process.env["CONDUCTOR_PROD_BACKEND_PORT"]?.trim(),
    "4749",
    "4748",
  ]
    .filter(
      (value, index, values): value is string =>
        Boolean(value) && values.indexOf(value) === index
    )
    .map((port) => `http://127.0.0.1:${port}`);

  for (const candidate of candidates) {
    if (await isHealthy(candidate)) {
      cachedBackendBaseUrl = candidate;
      return candidate;
    }
  }

  cachedBackendBaseUrl = candidates[0] ?? "http://127.0.0.1:4749";
  return cachedBackendBaseUrl;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text.trim()) {
    return `${response.status} ${response.statusText}`.trim();
  }

  try {
    const payload = JSON.parse(text) as { error?: string; detail?: string };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload.detail === "string" && payload.detail.trim()) {
      return payload.detail;
    }
  } catch {
    // Fall back to the raw response body.
  }

  return text;
}

export async function apiCall<T = JsonValue>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const baseUrl = await resolveBackendBaseUrl();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to reach Conductor backend at ${baseUrl}: ${message}. Run \`co start\`.`
    );
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export async function fetchConfiguredProjects(): Promise<
  Map<string, ConfigProject>
> {
  const response = await apiCall<ConfigResponse>("GET", "/api/config");
  return new Map(response.projects.map((project) => [project.id, project]));
}

export async function fetchProjects(): Promise<Map<string, BackendProject>> {
  const projects = await apiCall<BackendProject[]>("GET", "/api/projects");
  return new Map(projects.map((project) => [project.id, project]));
}

export function sessionWorktree(session: BackendSession): string | null {
  return session.workspacePath ?? session.metadata["worktree"] ?? null;
}
