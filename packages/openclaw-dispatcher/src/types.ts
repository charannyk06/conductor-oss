export type DispatcherFeedEntryKind =
  | "assistant"
  | "status"
  | "system"
  | "tool"
  | "user";

export type DispatcherFeedEntry = {
  id: string;
  kind: DispatcherFeedEntryKind;
  label: string;
  text: string;
  createdAt: string | null;
  attachments: unknown[];
  source: string;
  streaming: boolean;
  metadata: Record<string, unknown>;
};

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
  entries: DispatcherFeedEntry[];
  totalEntries: number;
  windowLimit: number;
  truncated: boolean;
  sessionStatus: string | null;
  approvalState?: string | null;
  parserState?: unknown;
  runtimeStatus?: unknown;
  source?: string | null;
  error?: string | null;
  integration?: DispatcherFeedIntegration | null;
};

export type DispatcherFeedDelta =
  | {
      type: "append";
      entries: DispatcherFeedEntry[];
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: string | null;
      approvalState: string | null;
      parserState: unknown;
      runtimeStatus: unknown;
      source: string | null;
      error: string | null;
      integration: DispatcherFeedIntegration | null;
    }
  | {
      type: "patch";
      entryId: string;
      entry: DispatcherFeedEntry | null;
      textDelta: string | null;
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: string | null;
      approvalState: string | null;
      parserState: unknown;
      runtimeStatus: unknown;
      source: string | null;
      error: string | null;
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

export type DispatcherThreadRecord = Record<string, unknown>;

export type DispatcherThreadResponse = {
  thread: DispatcherThreadRecord | null;
};

export type DispatcherBindingEndpoints = {
  dispatcher: string | null;
  feed: string | null;
  stream: string | null;
  send: string | null;
  interrupt: string | null;
  tasks: string;
};

export type DispatcherBinding = {
  id: string;
  projectId: string;
  provider: string;
  threadId: string | null;
  sessionId: string | null;
  channelId: string | null;
  bridgeId: string | null;
  dispatcherThreadId: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  dispatcherThread: DispatcherThreadRecord | null;
  dispatcherEndpoints: DispatcherBindingEndpoints;
};

export type DispatcherBindingQuery = {
  bindingId?: string;
  provider?: string;
  threadId?: string;
  sessionId?: string;
  channelId?: string;
  bridgeId?: string;
  dispatcherThreadId?: string;
};

export type DispatcherBindingResponse = {
  binding: DispatcherBinding | null;
};

export type DispatcherBindingListResponse = {
  bindings: DispatcherBinding[];
};

export type DispatcherBindingsResponse =
  | DispatcherBindingResponse
  | DispatcherBindingListResponse;

export type DispatcherTaskPacket = Record<string, unknown>;

export type DispatcherTaskRecord = Record<string, unknown>;

export type DispatcherTaskMutationOperation = "create" | "update" | "handoff";

export type DispatcherTaskMutationResponse = Record<string, unknown> & {
  operation: DispatcherTaskMutationOperation;
  task: DispatcherTaskRecord;
  createdTaskId?: string;
  updatedTaskId?: string;
  handedOffTaskId?: string;
};

export type DispatcherLifecycleEventType =
  | "dispatcher_task_created"
  | "dispatcher_task_updated"
  | "dispatcher_task_handed_off"
  | "dispatcher_task_deleted"
  | "dispatcher_session_launched"
  | "dispatcher_blocker_detected"
  | "dispatcher_session_completed"
  | "dispatcher_session_failed";

export type DispatcherEntryClassification =
  | DispatcherFeedEntryKind
  | "heartbeat"
  | "task_created"
  | "task_updated"
  | "task_handed_off"
  | "task_deleted"
  | "session_launched"
  | "blocker_detected"
  | "session_completed"
  | "session_failed";

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

export type OpenClawBindingTarget = {
  provider?: string;
  bindingId?: string;
  threadId?: string;
  sessionId?: string;
  channelId?: string;
  bridgeId?: string;
  dispatcherThreadId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type EnsureOpenClawBindingOptions = {
  bindingId?: string;
  createDispatcher?: boolean;
  forceNewDispatcher?: boolean;
  dispatcherAgent?: string;
  implementationAgent?: string;
  model?: string;
  reasoningEffort?: string;
  implementationModel?: string;
  implementationReasoningEffort?: string;
  title?: string;
  metadata?: Record<string, unknown>;
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

export type UpsertDispatcherBindingBody = {
  bindingId?: string;
  provider: string;
  threadId?: string;
  sessionId?: string;
  channelId?: string;
  bridgeId?: string;
  dispatcherThreadId?: string;
  createDispatcher?: boolean;
  forceNewDispatcher?: boolean;
  dispatcherAgent?: string;
  implementationAgent?: string;
  model?: string;
  reasoningEffort?: string;
  implementationModel?: string;
  implementationReasoningEffort?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};
