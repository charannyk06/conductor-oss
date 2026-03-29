# @conductor-oss/openclaw-dispatcher

TypeScript client for Conductor’s **project dispatcher** HTTP API: feed, SSE stream, send, interrupt, task lifecycle, OpenClaw **integration** binding, and optional **bindings** store.

See [`docs/openclaw-integration-contract.md`](../../docs/openclaw-integration-contract.md) for the full contract.

```ts
import { ConductorDispatcherClient } from "@conductor-oss/openclaw-dispatcher";

const client = new ConductorDispatcherClient({
  baseUrl: process.env.CONDUCTOR_BACKEND_URL ?? "http://127.0.0.1:4748",
});

await client.patchIntegration("my-project", { openclawThreadId: "thread-123" }, { threadId: dispatcherThreadId });
for await (const delta of client.streamFeedDeltas("my-project", { threadId: dispatcherThreadId })) {
  console.log(delta);
}
```

`streamFeed()` returns the raw SSE contract: the first item is a full feed payload, and later items are typed deltas. `streamFeedDeltas()` normalizes that first snapshot into `{ type: "replace", payload }`, which is usually the easiest contract for orchestrator clients.

Build: `bun run --cwd packages/openclaw-dispatcher build`
