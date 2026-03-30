import type {
  ConductorDispatcherClientOptions,
  CreateDispatcherBody,
  DispatcherBindingListResponse,
  DispatcherBindingQuery,
  DispatcherBindingResponse,
  DispatcherBindingsResponse,
  DispatcherFeedDelta,
  DispatcherFeedPayload,
  DispatcherFeedStreamEvent,
  DispatcherQuery,
  DispatcherTaskMutationResponse,
  DispatcherThreadResponse,
  PatchDispatcherPreferencesBody,
  PatchIntegrationBody,
  SendToDispatcherBody,
  UpsertDispatcherBindingBody,
} from "./types.js";

function trimBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === baseUrl.length ? baseUrl : baseUrl.slice(0, end);
}

function buildQuery(query?: DispatcherQuery): string {
  if (!query) return "";
  const p = new URLSearchParams();
  if (query.bridgeId) p.set("bridgeId", query.bridgeId);
  if (query.threadId) p.set("threadId", query.threadId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function buildBindingQuery(query?: DispatcherBindingQuery): string {
  if (!query) return "";
  const p = new URLSearchParams();
  if (query.bindingId) p.set("bindingId", query.bindingId);
  if (query.provider) p.set("provider", query.provider);
  if (query.threadId) p.set("threadId", query.threadId);
  if (query.sessionId) p.set("sessionId", query.sessionId);
  if (query.channelId) p.set("channelId", query.channelId);
  if (query.bridgeId) p.set("bridgeId", query.bridgeId);
  if (query.dispatcherThreadId) p.set("dispatcherThreadId", query.dispatcherThreadId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function hasExplicitBindingTarget(query?: DispatcherBindingQuery): boolean {
  return Boolean(
    query?.bindingId ||
      query?.threadId ||
      query?.sessionId ||
      query?.channelId ||
      query?.dispatcherThreadId,
  );
}

/**
 * Parse one SSE frame (after the blank line that ends the previous frame).
 * Concatenates multiple `data:` lines per the SSE spec.
 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

function parseSseValue(rawValue: string): string {
  return rawValue.trimStart();
}

function parseRawSseFrame(rawFrame: string): {
  event: string | null;
  data: string;
} | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = parseSseValue(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(parseSseValue(line.slice(5)));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join("\n") };
}

function parseNextSseFrame(
  buffer: string,
): { frame: { event: string | null; data: string } | null; rest: string } {
  let remaining = buffer;
  for (;;) {
    const m = remaining.match(FRAME_SEPARATOR);
    if (!m) {
      return { frame: null, rest: remaining };
    }
    const rawFrame = remaining.slice(0, m.index);
    remaining = remaining.slice(m.index + m[0].length);
    const frame = parseRawSseFrame(rawFrame);
    if (!frame) {
      continue;
    }
    return { frame, rest: remaining };
  }
}

function isDispatcherFeedDelta(
  value: DispatcherFeedStreamEvent,
): value is DispatcherFeedDelta {
  return typeof (value as { type?: unknown }).type === "string";
}

function mergeHeaders(
  options: ConductorDispatcherClientOptions,
  init?: HeadersInit,
): Headers {
  const h = new Headers(init);
  if (options.authToken) {
    h.set("Authorization", `Bearer ${options.authToken}`);
  }
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      h.set(k, v);
    }
  }
  return h;
}

/**
 * HTTP client for Conductor project dispatcher APIs — intended for OpenClaw
 * or any external orchestrator that routes user chat into Conductor.
 */
export class ConductorDispatcherClient {
  readonly baseUrl: string;
  private readonly options: ConductorDispatcherClientOptions;

  constructor(options: ConductorDispatcherClientOptions) {
    this.options = options;
    this.baseUrl = trimBaseUrl(options.baseUrl);
  }

  private async json<T>(
    path: string,
    init: RequestInit & { expectJson?: boolean } = {},
  ): Promise<T> {
    const { expectJson = true, ...rest } = init;
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers: mergeHeaders(this.options, rest.headers),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Conductor ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!expectJson || !text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  async getDispatcher(
    projectId: string,
    query?: DispatcherQuery,
  ): Promise<DispatcherThreadResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher${buildQuery(query)}`,
    );
  }

  async listDispatchers(
    projectId: string,
    query?: DispatcherQuery,
  ): Promise<{ threads: unknown[]; activeThreadId: string | null }> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatchers${buildQuery(query)}`,
    );
  }

  /** Create a new project dispatcher thread (or force one with `forceNew`). */
  async createDispatcher(
    projectId: string,
    body: CreateDispatcherBody,
    query?: DispatcherQuery,
  ): Promise<DispatcherThreadResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher${buildQuery(query)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forceNew: body.forceNew,
          agent: body.agent,
          dispatcherAgent: body.dispatcherAgent,
          implementationAgent: body.implementationAgent,
          openclawGatewayUrl: body.openclawGatewayUrl,
          openclawGatewayToken: body.openclawGatewayToken,
          openclawGatewayScopes: body.openclawGatewayScopes,
          openclawSessionKey: body.openclawSessionKey,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          implementationModel: body.implementationModel,
          implementationReasoningEffort: body.implementationReasoningEffort,
        }),
      },
    );
  }

  /** Delete the resolved dispatcher thread. */
  async deleteDispatcher(
    projectId: string,
    query?: DispatcherQuery,
  ): Promise<{ deletedThreadId: string }> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher${buildQuery(query)}`,
      { method: "DELETE" },
    );
  }

  /** Update implementation agent/model preferences for the dispatcher. */
  async patchPreferences(
    projectId: string,
    body: PatchDispatcherPreferencesBody,
    query?: DispatcherQuery,
  ): Promise<DispatcherThreadResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/preferences${buildQuery(query)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          implementationAgent: body.implementationAgent,
          implementationModel: body.implementationModel,
          implementationReasoningEffort: body.implementationReasoningEffort,
          openclawGatewayUrl: body.openclawGatewayUrl,
          openclawGatewayToken: body.openclawGatewayToken,
          openclawGatewayScopes: body.openclawGatewayScopes,
          openclawSessionKey: body.openclawSessionKey,
        }),
      },
    );
  }

  async getFeed(
    projectId: string,
    query?: DispatcherQuery & { limit?: number },
  ): Promise<DispatcherFeedPayload> {
    const q = new URLSearchParams();
    if (query?.bridgeId) q.set("bridgeId", query.bridgeId);
    if (query?.threadId) q.set("threadId", query.threadId);
    if (query?.limit != null) q.set("limit", String(query.limit));
    const qs = q.toString();
    const suffix = qs ? `?${qs}` : "";
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/feed${suffix}`,
    );
  }

  async send(
    projectId: string,
    body: SendToDispatcherBody,
    query?: DispatcherQuery,
  ): Promise<{ ok: boolean; threadId: string }> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/send${buildQuery(query)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: body.message,
          attachments: body.attachments,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
        }),
      },
    );
  }

  async interrupt(projectId: string, query?: DispatcherQuery): Promise<{ ok: boolean; threadId: string }> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/interrupt${buildQuery(query)}`,
      { method: "POST" },
    );
  }

  /**
   * List or resolve project-scoped dispatcher bindings (external thread → dispatcher thread).
   * Pass query keys such as `provider`, `threadId`, `sessionId`, `bindingId`, `dispatcherThreadId`.
   */
  async getDispatcherBindings(
    projectId: string,
    query?: DispatcherBindingQuery,
  ): Promise<DispatcherBindingsResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/bindings${buildBindingQuery(query)}`,
    );
  }

  async getBinding(
    projectId: string,
    query: DispatcherBindingQuery,
  ): Promise<DispatcherBindingResponse> {
    if (!hasExplicitBindingTarget(query)) {
      throw new Error(
        "Binding lookup requires bindingId, threadId, sessionId, channelId, or dispatcherThreadId",
      );
    }
    const response = await this.getDispatcherBindings(projectId, query);
    if ("binding" in response) {
      return response;
    }
    throw new Error("Binding lookup returned a list response");
  }

  async listBindings(
    projectId: string,
    query?: DispatcherBindingQuery,
  ): Promise<DispatcherBindingListResponse> {
    const response = await this.getDispatcherBindings(projectId, query);
    if ("bindings" in response) {
      return response;
    }
    return { bindings: response.binding ? [response.binding] : [] };
  }

  /** Create or update a binding row (see Conductor `UpsertDispatcherBindingBody`). */
  async upsertDispatcherBinding(
    projectId: string,
    body: UpsertDispatcherBindingBody,
    query?: DispatcherBindingQuery,
  ): Promise<DispatcherBindingResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/bindings${buildBindingQuery(query)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  /**
   * Bind an OpenClaw (or other) chat thread to this Conductor dispatcher.
   * Omitted keys are left unchanged. Use `null` to clear a field (JSON null).
   */
  async patchIntegration(
    projectId: string,
    body: PatchIntegrationBody,
    query?: DispatcherQuery,
  ): Promise<DispatcherThreadResponse> {
    const payload: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "openclawThreadId")) {
      if (body.openclawThreadId !== undefined) {
        payload.openclawThreadId = body.openclawThreadId;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "openclawSessionId")) {
      if (body.openclawSessionId !== undefined) {
        payload.openclawSessionId = body.openclawSessionId;
      }
    }
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/integration${buildQuery(query)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  async createTask(
    projectId: string,
    body: Record<string, unknown>,
    query?: DispatcherQuery,
  ): Promise<DispatcherTaskMutationResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/tasks${buildQuery(query)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  async updateTask(
    projectId: string,
    taskLookup: string,
    body: Record<string, unknown>,
    query?: DispatcherQuery,
  ): Promise<DispatcherTaskMutationResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/tasks/${encodeURIComponent(taskLookup)}${buildQuery(query)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  async handoffTask(
    projectId: string,
    taskLookup: string,
    body: Record<string, unknown>,
    query?: DispatcherQuery,
  ): Promise<DispatcherTaskMutationResponse> {
    return this.json(
      `/api/projects/${encodeURIComponent(projectId)}/dispatcher/tasks/${encodeURIComponent(taskLookup)}/handoff${buildQuery(query)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  /**
   * Subscribe to dispatcher feed SSE.
   * The first yielded item is the raw feed snapshot payload.
   * Later items are typed deltas such as `append`, `patch`, `replace`, and `refresh`.
   * Abort via `signal` on the optional `init` argument.
   */
  async *streamFeed(
    projectId: string,
    query?: DispatcherQuery & { limit?: number },
    init?: RequestInit,
  ): AsyncGenerator<DispatcherFeedStreamEvent, void, undefined> {
    const q = new URLSearchParams();
    if (query?.bridgeId) q.set("bridgeId", query.bridgeId);
    if (query?.threadId) q.set("threadId", query.threadId);
    if (query?.limit != null) q.set("limit", String(query.limit));
    const qs = q.toString();
    const suffix = qs ? `?${qs}` : "";
    const res = await fetch(
      `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/dispatcher/feed/stream${suffix}`,
      {
        ...init,
        headers: mergeHeaders(this.options, {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...init?.headers,
        }),
      },
    );
    if (!res.ok || !res.body) {
      const t = await res.text();
      throw new Error(`Conductor stream ${res.status}: ${t.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (!done && value) {
          buffer += decoder.decode(value, { stream: true });
        } else if (done) {
          buffer += decoder.decode(undefined, { stream: false });
        }
        for (;;) {
          const { frame, rest } = parseNextSseFrame(buffer);
          buffer = rest;
          if (!frame) {
            break;
          }
          try {
            const parsed = JSON.parse(frame.data) as DispatcherFeedStreamEvent;
            yield parsed;
          } catch {
            /* ignore malformed chunk */
          }
        }
        if (done) {
          const finalFrame = parseRawSseFrame(buffer);
          if (finalFrame) {
            try {
              const parsed = JSON.parse(finalFrame.data) as DispatcherFeedStreamEvent;
              yield parsed;
            } catch {
              /* ignore malformed chunk */
            }
          }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Subscribe to dispatcher feed SSE and normalize the initial snapshot into a `replace` delta.
   * This is the most convenient stream shape for clients that want a single event contract.
   */
  async *streamFeedDeltas(
    projectId: string,
    query?: DispatcherQuery & { limit?: number },
    init?: RequestInit,
  ): AsyncGenerator<DispatcherFeedDelta, void, undefined> {
    for await (const event of this.streamFeed(projectId, query, init)) {
      if (isDispatcherFeedDelta(event)) {
        yield event;
        continue;
      }
      yield { type: "replace", payload: event as DispatcherFeedPayload };
    }
  }
}
