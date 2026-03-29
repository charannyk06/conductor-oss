/** Feed payload from GET /api/projects/:projectId/dispatcher/feed or SSE stream. */
export type DispatcherFeedIntegration = {
  projectId: string;
  threadId: string;
  bridgeId: string | null;
  openclaw: {
    threadId: string | null;
    sessionId: string | null;
  };
  heartbeat: {
    state: string | null;
    nextAt: string | null;
  };
  memory: {
    projectPath: string | null;
    sessionPath: string | null;
  };
};

export type DispatcherFeedPayload = {
  entries: unknown[];
  totalEntries: number;
  windowLimit: number;
  truncated: boolean;
  sessionStatus: string | null;
  approvalState?: string | null;
  parserState?: unknown;
  runtimeStatus?: unknown;
  source?: string;
  error?: string;
  integration?: DispatcherFeedIntegration | null;
};

export type DispatcherFeedDelta =
  | {
      type: "append";
      entries: unknown[];
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: unknown;
      approvalState: unknown;
      parserState: unknown;
      runtimeStatus: unknown;
      source: unknown;
      error: unknown;
      integration: DispatcherFeedIntegration | null;
    }
  | {
      type: "patch";
      entryId: string;
      entry: unknown;
      textDelta: string | null;
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: unknown;
      approvalState: unknown;
      parserState: unknown;
      runtimeStatus: unknown;
      source: unknown;
      error: unknown;
      integration: DispatcherFeedIntegration | null;
    }
  | {
      type: "replace";
      payload: DispatcherFeedPayload;
    }
  | {
      type: "refresh";
      reason: string;
      missed?: number;
    };

/**
 * Raw event stream item from the dispatcher SSE endpoint.
 * The first frame is a full feed payload without a `type` field.
 * Later frames are typed deltas such as `append`, `patch`, `replace`, and `refresh`.
 */
export type DispatcherFeedStreamEvent = DispatcherFeedPayload | DispatcherFeedDelta;

export type DispatcherThreadResponse = {
  thread: Record<string, unknown> | null;
};

export type ConductorDispatcherClientOptions = {
  /** Base URL of the Conductor Rust backend, e.g. http://127.0.0.1:4748 */
  baseUrl: string;
  /** Optional bearer token when the backend requires auth */
  authToken?: string;
  /** Extra headers on every request */
  headers?: Record<string, string>;
};

export type DispatcherQuery = {
  bridgeId?: string;
  threadId?: string;
};

export type SendToDispatcherBody = {
  message: string;
  attachments?: string[];
  model?: string;
  reasoningEffort?: string;
};

export type PatchIntegrationBody = {
  /** Set OpenClaw (or other orchestrator) thread id; JSON `null` clears */
  openclawThreadId?: string | null;
  /** Set orchestrator session id; JSON `null` clears */
  openclawSessionId?: string | null;
};

/** POST /api/projects/:projectId/dispatcher */
export type CreateDispatcherBody = {
  forceNew?: boolean;
  agent?: string;
  dispatcherAgent?: string;
  implementationAgent?: string;
  model?: string;
  reasoningEffort?: string;
  implementationModel?: string;
  implementationReasoningEffort?: string;
};

/** PATCH /api/projects/:projectId/dispatcher/preferences */
export type PatchDispatcherPreferencesBody = {
  implementationAgent?: string;
  implementationModel?: string;
  implementationReasoningEffort?: string;
};
