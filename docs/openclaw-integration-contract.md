# OpenClaw ↔ Conductor dispatcher integration contract

This document is the HTTP contract between **OpenClaw** (or any external orchestrator) and the **Conductor Rust backend**. The dashboard may proxy these routes under `/api/projects/...` when using the Next.js app.

For product goals and responsibility split, see [`openclaw-dispatcher-frontdoor.md`](./openclaw-dispatcher-frontdoor.md).

## Base URL and auth

- **Base URL:** the Conductor backend (for example `http://127.0.0.1:4748` or `http://127.0.0.1:4749` in dev).
- **Auth:** when enabled, send `Authorization: Bearer <token>` on every request. The TypeScript client [`@conductor-oss/openclaw-dispatcher`](../packages/openclaw-dispatcher) accepts `authToken`.

## Common query parameters

Most dispatcher routes accept optional scoping:

| Query | Meaning |
|-------|---------|
| `threadId` | Conductor **dispatcher session** id (UUID). Selects a specific project dispatcher thread. |
| `bridgeId` | When using a paired bridge, scope the dispatcher to that bridge. |

If `threadId` is omitted, Conductor uses the latest dispatcher thread for the project (and optional `bridgeId`).

## Endpoints

### List dispatcher threads

`GET /api/projects/{projectId}/dispatchers?bridgeId=`

**Response:** `{ threads: Session[], activeThreadId: string | null }`

### Get or resolve dispatcher

`GET /api/projects/{projectId}/dispatcher?threadId=&bridgeId=`

**Response:** `{ thread: Session | null }`  
`404` if no dispatcher exists and none can be implied.

### Create dispatcher thread

`POST /api/projects/{projectId}/dispatcher?bridgeId=`

**Body (JSON, camelCase):**

| Field | Description |
|-------|-------------|
| `forceNew` | If true, always create a new thread. |
| `agent` / `dispatcherAgent` | Dispatcher agent id. |
| `implementationAgent` | Default coding agent for handoffs. |
| `openclawGatewayUrl` | Optional OpenClaw gateway URL when the dispatcher or implementation runtime uses OpenClaw. |
| `openclawGatewayToken` | Optional OpenClaw gateway bearer token override. |
| `openclawGatewayScopes` | Optional comma-separated gateway scopes override. |
| `openclawSessionKey` | Optional explicit OpenClaw session key override. |
| `model` | Dispatcher model. |
| `reasoningEffort` | Dispatcher reasoning. |
| `implementationModel` | Default implementation model. |
| `implementationReasoningEffort` | Default implementation reasoning. |

**Response:** `201` `{ thread: Session }`

### Delete dispatcher thread

`DELETE /api/projects/{projectId}/dispatcher?threadId=&bridgeId=`

**Response:** `{ deletedThreadId: string }`

### Dispatcher preferences (implementation agent / model)

`PATCH /api/projects/{projectId}/dispatcher/preferences?threadId=&bridgeId=`

**Body:** `{ implementationAgent?, implementationModel?, implementationReasoningEffort?, openclawGatewayUrl?, openclawGatewayToken?, openclawGatewayScopes?, openclawSessionKey? }`

**Response:** `{ thread: Session }`

### OpenClaw integration binding

Binds an external OpenClaw **chat thread** and optional **session** id to the resolved dispatcher thread. Used so OpenClaw can correlate its Discord/Slack/web thread with Conductor’s dispatcher.

`PATCH /api/projects/{projectId}/dispatcher/integration?threadId=&bridgeId=`

**Body:** Each key is optional. Omit a key to leave it unchanged. JSON `null` clears the stored value.

```json
{
  "openclawThreadId": "discord-thread-42",
  "openclawSessionId": "openclaw-session-9"
}
```

**Response:** `{ thread: Session }`

Metadata on the session includes `openclawThreadId` and `openclawSessionId`.

### External thread bindings (optional registry)

For richer routing (e.g. multiple external threads per project), use the bindings store:

`GET /api/projects/{projectId}/dispatcher/bindings?provider=openclaw&threadId=&sessionId=&bindingId=&dispatcherThreadId=&bridgeId=`

`POST /api/projects/{projectId}/dispatcher/bindings?...`

**POST body (camelCase):** includes `provider`, optional `threadId`, `sessionId`, `channelId`, `bridgeId`, `dispatcherThreadId`, `createDispatcher`, `forceNewDispatcher`, agent/model fields, `title`, `metadata`, etc. See `UpsertDispatcherBindingBody` in `crates/conductor-server/src/routes/dispatcher.rs`.

When a binding resolves to a specific dispatcher thread, the response includes `dispatcherEndpoints.*` helpers. The `tasks` helper is thread-scoped, so create-task requests stay pinned to that dispatcher thread instead of drifting to whichever dispatcher became latest later.

### Feed (snapshot)

`GET /api/projects/{projectId}/dispatcher/feed?limit=120&threadId=&bridgeId=`

- `limit` is clamped (default 120, max 240).

**Response:** JSON object:

| Field | Description |
|-------|-------------|
| `entries` | Normalized chat feed entries (user / assistant / tool / status / system). |
| `totalEntries` | Total count before windowing. |
| `windowLimit` | Max entries returned. |
| `truncated` | Whether older entries were dropped. |
| `sessionStatus` | Dispatcher session status. |
| `approvalState` | Plan approval state when applicable. |
| `parserState` | Optional parser hint object. |
| `runtimeStatus` | Reserved. |
| `source` | `"conversation-only"` or `"runtime-output"`. |
| `integration` | See [Integration object](#integration-object). |

### Feed stream (SSE)

`GET /api/projects/{projectId}/dispatcher/feed/stream?limit=120&threadId=&bridgeId=`

- **Media type:** `text/event-stream`.
- First event: full feed payload JSON (same shape as GET feed).
- Later events: JSON **delta** objects (see [Feed SSE deltas](#feed-sse-deltas)).
- Custom `event: refresh` with body `{ "type": "refresh", "reason": "lagged", "missed": <n> }` if the client lagged the broadcast.

OpenClaw should subscribe to this stream (or poll GET feed) to mirror dispatcher activity, task updates, and integration metadata into chat.

### Send a user turn

`POST /api/projects/{projectId}/dispatcher/send?threadId=&bridgeId=`

**Body:**

```json
{
  "message": "string",
  "attachments": ["path-or-uri"],
  "model": "optional",
  "reasoningEffort": "optional"
}
```

If no dispatcher exists and `threadId` is **not** set, Conductor may **create** a dispatcher thread automatically.

**Response:** `{ "ok": true, "threadId": "<dispatcher session id>" }`

### Interrupt

`POST /api/projects/{projectId}/dispatcher/interrupt?threadId=&bridgeId=`

**Response:** `{ "ok": true, "threadId": "..." }`

### Task lifecycle (board-backed)

| Method | Path |
|--------|------|
| `POST` | `/api/projects/{projectId}/dispatcher/tasks?threadId=&bridgeId=` |
| `PATCH` | `/api/projects/{projectId}/dispatcher/tasks/{taskLookup}?threadId=&bridgeId=` |
| `POST` | `/api/projects/{projectId}/dispatcher/tasks/{taskLookup}/handoff?threadId=&bridgeId=` |

Task bodies use **camelCase** fields such as `title`, `description`, `role`, `agent`, `model`, `executionMode`, etc. See `DispatcherTaskCreateInput` / `DispatcherTaskUpdateInput` in `crates/conductor-server/src/dispatcher_task_lifecycle.rs`.

## Integration object

When present on the feed, `integration` describes orchestrator binding and optional ACP metadata paths:

```json
{
  "projectId": "my-project",
  "threadId": "<conductor dispatcher session id>",
  "bridgeId": null,
  "openclaw": {
    "threadId": "<external thread id>",
    "sessionId": "<external session id>",
    "gatewayUrl": "ws://127.0.0.1:18789",
    "gatewayTokenConfigured": "true",
    "gatewayScopes": "operator.read,operator.write",
    "sessionKey": "conductor:project_dispatcher:demo:dispatcher-123"
  },
  "heartbeat": {
    "state": "...",
    "nextAt": "..."
  },
  "memory": {
    "projectPath": "...",
    "sessionPath": "..."
  }
}
```

**Memory and heartbeat:** the front-door design assigns **long-term / short-term memory and proactive heartbeat** primarily to **OpenClaw**. Conductor may still expose paths or state hints here for alignment; treat them as hints, not a second source of truth for orchestrator memory.

## Feed SSE deltas

After the initial full payload, each `data:` line is a JSON object:

### `append`

New tail entries and updated counters. Shipped when the new feed is a suffix extension of the previous one.

```json
{
  "type": "append",
  "entries": [ ... ],
  "totalEntries": 0,
  "windowLimit": 120,
  "truncated": false,
  "sessionStatus": null,
  "approvalState": null,
  "parserState": null,
  "runtimeStatus": null,
  "source": null,
  "error": null,
  "integration": { ... }
}
```

### `replace`

Full feed replacement (e.g. after truncation or non-appendable change).

```json
{
  "type": "replace",
  "payload": { ... same shape as GET feed ... }
}
```

### `refresh` (in `event: refresh` or embedded)

Client should refetch GET feed if it missed updates.

## TypeScript client

[`packages/openclaw-dispatcher`](../packages/openclaw-dispatcher) implements this contract (`ConductorDispatcherClient`).

- `streamFeed()` yields the raw SSE contract: the first item is the full feed snapshot, later items are typed deltas.
- `streamFeedDeltas()` normalizes that initial snapshot into `{ type: "replace", payload }`, which is usually the simplest shape for OpenClaw-side consumers.

## Smoke test

With the backend running:

```bash
CONDUCTOR_BACKEND_URL=http://127.0.0.1:4749 CONDUCTOR_SMOKE_PROJECT_ID=<project> bun scripts/openclaw-dispatcher-smoke.mjs
```

See [`scripts/openclaw-dispatcher-smoke.mjs`](../scripts/openclaw-dispatcher-smoke.mjs).
