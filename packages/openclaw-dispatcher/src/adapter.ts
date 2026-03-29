import { ConductorDispatcherClient } from "./client.js";
import type {
  DispatcherBinding,
  DispatcherBindingQuery,
  DispatcherEntryClassification,
  DispatcherFeedDelta,
  DispatcherFeedEntry,
  DispatcherFeedStreamEvent,
  DispatcherLifecycleEventType,
  DispatcherQuery,
  DispatcherTaskMutationResponse,
  DispatcherFeedPayload,
  EnsureOpenClawBindingOptions,
  OpenClawBindingTarget,
  SendToDispatcherBody,
  UpsertDispatcherBindingBody,
} from "./types.js";

export type BoundDispatcherResult<T> = {
  binding: DispatcherBinding;
  query: DispatcherQuery;
  response: T;
};

function normalizeText(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return Object.fromEntries(entries.map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value ?? null));
}

function buildBindingQuery(
  target: OpenClawBindingTarget,
  fallbackProvider: string,
): DispatcherBindingQuery {
  return {
    bindingId: normalizeText(target.bindingId),
    provider: normalizeText(target.provider) ?? fallbackProvider,
    threadId: normalizeText(target.threadId),
    sessionId: normalizeText(target.sessionId),
    channelId: normalizeText(target.channelId),
    bridgeId: normalizeText(target.bridgeId),
    dispatcherThreadId: normalizeText(target.dispatcherThreadId),
  };
}

function hasBindingTarget(query: DispatcherBindingQuery): boolean {
  return Boolean(
    query.bindingId ||
      query.threadId ||
      query.sessionId ||
      query.channelId ||
      query.dispatcherThreadId,
  );
}

function bindingNeedsUpsert(
  binding: DispatcherBinding,
  target: OpenClawBindingTarget,
  options: EnsureOpenClawBindingOptions,
): boolean {
  const desiredThreadId = normalizeText(target.threadId);
  if (desiredThreadId !== undefined && binding.threadId !== desiredThreadId) {
    return true;
  }

  const desiredSessionId = normalizeText(target.sessionId);
  if (desiredSessionId !== undefined && binding.sessionId !== desiredSessionId) {
    return true;
  }

  const desiredChannelId = normalizeText(target.channelId);
  if (desiredChannelId !== undefined && binding.channelId !== desiredChannelId) {
    return true;
  }

  const desiredBridgeId = normalizeText(target.bridgeId);
  if (desiredBridgeId !== undefined && binding.bridgeId !== desiredBridgeId) {
    return true;
  }

  const desiredDispatcherThreadId = normalizeText(target.dispatcherThreadId);
  if (
    desiredDispatcherThreadId !== undefined &&
    binding.dispatcherThreadId !== desiredDispatcherThreadId
  ) {
    return true;
  }

  const desiredTitle = normalizeText(options.title ?? target.title);
  if (desiredTitle !== undefined && binding.title !== desiredTitle) {
    return true;
  }

  const desiredMetadata = options.metadata ?? target.metadata;
  if (desiredMetadata !== undefined && stableJson(binding.metadata) !== stableJson(desiredMetadata)) {
    return true;
  }

  if (options.forceNewDispatcher) {
    return true;
  }

  return (options.createDispatcher ?? true) && !bindingHasDispatcherThread(binding);
}

function buildUpsertBody(
  target: OpenClawBindingTarget,
  fallbackProvider: string,
  options: EnsureOpenClawBindingOptions,
): UpsertDispatcherBindingBody {
  return {
    bindingId: normalizeText(options.bindingId ?? target.bindingId),
    provider: normalizeText(target.provider) ?? fallbackProvider,
    threadId: normalizeText(target.threadId),
    sessionId: normalizeText(target.sessionId),
    channelId: normalizeText(target.channelId),
    bridgeId: normalizeText(target.bridgeId),
    dispatcherThreadId: normalizeText(target.dispatcherThreadId),
    createDispatcher: options.createDispatcher ?? true,
    forceNewDispatcher: options.forceNewDispatcher ?? false,
    dispatcherAgent: normalizeText(options.dispatcherAgent),
    implementationAgent: normalizeText(options.implementationAgent),
    model: normalizeText(options.model),
    reasoningEffort: normalizeText(options.reasoningEffort),
    implementationModel: normalizeText(options.implementationModel),
    implementationReasoningEffort: normalizeText(options.implementationReasoningEffort),
    title: normalizeText(options.title ?? target.title),
    metadata: options.metadata ?? target.metadata,
  };
}

export function bindingHasDispatcherThread(binding: DispatcherBinding): boolean {
  return normalizeText(binding.dispatcherThreadId) !== undefined;
}

export function bindingToDispatcherQuery(binding: DispatcherBinding): DispatcherQuery {
  const query: DispatcherQuery = {};
  const bridgeId = normalizeText(binding.bridgeId);
  const threadId = normalizeText(binding.dispatcherThreadId);
  if (bridgeId) {
    query.bridgeId = bridgeId;
  }
  if (threadId) {
    query.threadId = threadId;
  }
  return query;
}

export function dispatcherEntriesFromEvent(
  event: DispatcherFeedStreamEvent | DispatcherFeedDelta,
): DispatcherFeedEntry[] {
  if ("type" in event) {
    if (event.type === "replace") {
      return event.payload.entries;
    }
    if (event.type === "append") {
      return event.entries;
    }
    if (event.type === "patch") {
      return event.entry ? [event.entry] : [];
    }
    return [];
  }
  return event.entries;
}

export function classifyDispatcherFeedEntry(
  entry: DispatcherFeedEntry,
): DispatcherEntryClassification {
  const eventType = normalizeText(entry.metadata.eventType as string | undefined) as
    | DispatcherLifecycleEventType
    | undefined;

  switch (eventType) {
    case "dispatcher_task_created":
      return "task_created";
    case "dispatcher_task_updated":
      return "task_updated";
    case "dispatcher_task_handed_off":
      return "task_handed_off";
    case "dispatcher_task_deleted":
      return "task_deleted";
    case "dispatcher_session_launched":
      return "session_launched";
    case "dispatcher_blocker_detected":
      return "blocker_detected";
    case "dispatcher_session_completed":
      return "session_completed";
    case "dispatcher_session_failed":
      return "session_failed";
    default:
      break;
  }

  if (entry.source === "acp_heartbeat") {
    return "heartbeat";
  }

  return entry.kind;
}

export class OpenClawDispatcherAdapter {
  readonly client: ConductorDispatcherClient;
  readonly provider: string;

  constructor(client: ConductorDispatcherClient, provider = "openclaw") {
    this.client = client;
    this.provider = provider;
  }

  async getBinding(
    projectId: string,
    target: OpenClawBindingTarget,
  ): Promise<DispatcherBinding | null> {
    const query = buildBindingQuery(target, this.provider);
    if (!hasBindingTarget(query)) {
      throw new Error(
        "OpenClaw binding lookup requires bindingId, threadId, sessionId, channelId, or dispatcherThreadId",
      );
    }
    const response = await this.client.getBinding(projectId, query);
    return response.binding;
  }

  async listBindings(
    projectId: string,
    target?: OpenClawBindingTarget,
  ): Promise<DispatcherBinding[]> {
    const response = await this.client.listBindings(
      projectId,
      target ? buildBindingQuery(target, this.provider) : { provider: this.provider },
    );
    return response.bindings;
  }

  async ensureBinding(
    projectId: string,
    target: OpenClawBindingTarget,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<DispatcherBinding> {
    const existing = await this.getBinding(projectId, target);

    if (existing && !bindingNeedsUpsert(existing, target, options)) {
      return existing;
    }

    const response = await this.client.upsertDispatcherBinding(
      projectId,
      buildUpsertBody(target, this.provider, options),
    );
    if (!response.binding) {
      throw new Error("Dispatcher binding upsert did not return a binding");
    }
    return response.binding;
  }

  async resolveThreadScope(
    projectId: string,
    target: OpenClawBindingTarget,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<{ binding: DispatcherBinding; query: DispatcherQuery }> {
    const binding = await this.ensureBinding(projectId, target, options);
    if (!bindingHasDispatcherThread(binding)) {
      throw new Error("Dispatcher binding is not attached to a dispatcher thread");
    }
    return {
      binding,
      query: bindingToDispatcherQuery(binding),
    };
  }

  async getFeed(
    projectId: string,
    target: OpenClawBindingTarget,
    options: EnsureOpenClawBindingOptions & { limit?: number } = {},
  ): Promise<BoundDispatcherResult<DispatcherFeedPayload>> {
    const { binding, query } = await this.resolveThreadScope(projectId, target, options);
    const response = await this.client.getFeed(projectId, {
      ...query,
      limit: options.limit,
    });
    return { binding, query, response };
  }

  async send(
    projectId: string,
    target: OpenClawBindingTarget,
    body: SendToDispatcherBody,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<BoundDispatcherResult<{ ok: boolean; threadId: string }>> {
    const { binding, query } = await this.resolveThreadScope(projectId, target, options);
    const response = await this.client.send(projectId, body, query);
    return { binding, query, response };
  }

  async interrupt(
    projectId: string,
    target: OpenClawBindingTarget,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<BoundDispatcherResult<{ ok: boolean; threadId: string }>> {
    const { binding, query } = await this.resolveThreadScope(projectId, target, options);
    const response = await this.client.interrupt(projectId, query);
    return { binding, query, response };
  }

  async createTask(
    projectId: string,
    target: OpenClawBindingTarget,
    body: Record<string, unknown>,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<BoundDispatcherResult<DispatcherTaskMutationResponse>> {
    const { binding, query } = await this.resolveThreadScope(projectId, target, options);
    const response = await this.client.createTask(projectId, body, query);
    return { binding, query, response };
  }

  async updateTask(
    projectId: string,
    target: OpenClawBindingTarget,
    taskLookup: string,
    body: Record<string, unknown>,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<BoundDispatcherResult<DispatcherTaskMutationResponse>> {
    const { binding, query } = await this.resolveThreadScope(projectId, target, options);
    const response = await this.client.updateTask(projectId, taskLookup, body, query);
    return { binding, query, response };
  }

  async handoffTask(
    projectId: string,
    target: OpenClawBindingTarget,
    taskLookup: string,
    body: Record<string, unknown>,
    options: EnsureOpenClawBindingOptions = {},
  ): Promise<BoundDispatcherResult<DispatcherTaskMutationResponse>> {
    const { binding, query } = await this.resolveThreadScope(projectId, target, options);
    const response = await this.client.handoffTask(projectId, taskLookup, body, query);
    return { binding, query, response };
  }

  async *streamFeed(
    projectId: string,
    target: OpenClawBindingTarget,
    options: EnsureOpenClawBindingOptions & { limit?: number } = {},
    init?: RequestInit,
  ): AsyncGenerator<DispatcherFeedDelta, void, undefined> {
    const { query } = await this.resolveThreadScope(projectId, target, options);
    for await (const event of this.client.streamFeedDeltas(
      projectId,
      {
        ...query,
        limit: options.limit,
      },
      init,
    )) {
      yield event;
    }
  }
}
