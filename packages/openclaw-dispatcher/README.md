# @conductor-oss/openclaw-dispatcher

TypeScript client for Conductor’s project dispatcher HTTP API: feed, SSE stream, send, interrupt, task lifecycle, OpenClaw integration binding, and the external-thread bindings registry.

See [`docs/openclaw-integration-contract.md`](../../docs/openclaw-integration-contract.md) for the full contract.

## Recommended OpenClaw flow

```ts
import {
  ConductorDispatcherClient,
  OpenClawDispatcherAdapter,
  classifyDispatcherFeedEntry,
} from "@conductor-oss/openclaw-dispatcher";

const client = new ConductorDispatcherClient({
  baseUrl: process.env.CONDUCTOR_BACKEND_URL ?? "http://127.0.0.1:4748",
});

const adapter = new OpenClawDispatcherAdapter(client);

const binding = await adapter.ensureBinding(
  "my-project",
  {
    threadId: "discord-thread-42",
    sessionId: "openclaw-session-9",
    channelId: "discord-channel-7",
  },
  {
    createDispatcher: true,
    implementationAgent: "codex",
    title: "OpenClaw project thread",
  },
);

await adapter.send("my-project", { threadId: binding.threadId ?? undefined }, {
  message: "Review the board and queue the next task.",
});

for await (const delta of adapter.streamFeed(
  "my-project",
  { threadId: binding.threadId ?? undefined },
  { limit: 120 },
)) {
  for (const entry of "payload" in delta ? delta.payload.entries : delta.type === "append" ? delta.entries : []) {
    console.log(classifyDispatcherFeedEntry(entry), entry.text);
  }
}
```

## API layers

- `ConductorDispatcherClient` is the low-level HTTP client for dispatcher, feed, send, interrupt, task lifecycle, integration binding, and bindings routes.
- `OpenClawDispatcherAdapter` is the higher-level helper for OpenClaw-style consumers. It resolves or creates external thread bindings, pins all requests to the correct dispatcher thread, and streams normalized feed deltas.
- `streamFeed()` returns the raw SSE contract: the first item is a full feed payload and later items are typed deltas.
- `streamFeedDeltas()` normalizes that initial snapshot into `{ type: "replace", payload }`.

## Useful exports

- `bindingHasDispatcherThread()` checks whether a binding already points at a concrete dispatcher thread.
- `bindingToDispatcherQuery()` converts a binding into the `threadId` and optional `bridgeId` scope used by dispatcher APIs.
- `dispatcherEntriesFromEvent()` extracts feed entries from append, patch, replace, or raw snapshot events.
- `classifyDispatcherFeedEntry()` maps normalized feed entries into OpenClaw-friendly categories such as task lifecycle, heartbeat, tool, and assistant output.

Build: `bun run --cwd packages/openclaw-dispatcher build`
