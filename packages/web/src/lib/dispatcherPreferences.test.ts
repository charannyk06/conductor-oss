import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewDispatcherConversationDefaults,
  createSerializedDispatcherPreferencePatchQueue,
  type DispatcherPreferencePatchRequest,
  dispatcherPreferencePatchScopeKey,
  resolveDispatcherSessionAgentName,
  sendDispatcherPreferencePatchRequest,
  DISPATCHER_HANDOFF_AGENT_OPTIONS,
  DISPATCHER_RUNTIME_AGENT_OPTIONS,
  isDispatcherRuntimeAgent,
  resolveDispatcherActiveAgentName,
} from "@/lib/dispatcherPreferences";

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("cursor stays available for handoff but not dispatcher runtime", () => {
  const handoffOptions: readonly string[] = DISPATCHER_HANDOFF_AGENT_OPTIONS;
  const runtimeOptions: readonly string[] = DISPATCHER_RUNTIME_AGENT_OPTIONS;

  assert.equal(handoffOptions.includes("cursor-cli"), true);
  assert.equal(runtimeOptions.includes("cursor-cli"), false);
  assert.equal(isDispatcherRuntimeAgent("cursor-cli"), false);
});

test("new dispatcher conversation defaults follow the global coding agent instead of an active errored thread", () => {
  assert.deepEqual(buildNewDispatcherConversationDefaults("cursor-cli"), {
    runtimeAgent: "codex",
    implementationAgent: "cursor-cli",
  });

  assert.deepEqual(buildNewDispatcherConversationDefaults("gemini"), {
    runtimeAgent: "gemini",
    implementationAgent: "gemini",
  });
});

test("dispatcher installation checks follow the live runtime agent after preference changes", () => {
  assert.equal(
    resolveDispatcherActiveAgentName({
      isDispatcher: true,
      sessionAgent: "gemini",
      legacyMetadataAgent: "codex",
      repositoryAgent: "cursor-cli",
    }),
    "gemini",
  );

  assert.equal(
    resolveDispatcherActiveAgentName({
      isDispatcher: false,
      sessionAgent: "gemini",
      legacyMetadataAgent: "codex",
      repositoryAgent: "cursor-cli",
    }),
    "cursor-cli",
  );
});

test("dispatcher runtime resolution preserves a top-level Claude agent over legacy metadata", () => {
  assert.equal(
    resolveDispatcherSessionAgentName({
      sessionAgent: "claude-code",
      legacyMetadataAgent: "codex",
    }),
    "claude-code",
  );

  assert.equal(
    resolveDispatcherActiveAgentName({
      isDispatcher: true,
      sessionAgent: "claude-code",
      legacyMetadataAgent: "codex",
      repositoryAgent: "codex",
    }),
    "claude-code",
  );
});

test("dispatcher runtime resolution falls back to legacy metadata only when the top-level agent is absent", () => {
  assert.equal(
    resolveDispatcherSessionAgentName({
      sessionAgent: null,
      legacyMetadataAgent: "gemini",
    }),
    "gemini",
  );
});

test("serialized dispatcher preference patch queue coalesces quick edits behind the active request", async () => {
  const calls: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferredPromise<void>>>();
  const queue = createSerializedDispatcherPreferencePatchQueue<string, string>({
    getScopeKey: () => "demo-thread",
    send: async (payload) => {
      calls.push(payload);
      const gate = deferredPromise<void>();
      pending.set(payload, gate);
      await gate.promise;
      return payload;
    },
  });

  queue.schedule("runtime=codex");
  queue.schedule("runtime=gemini");
  queue.schedule("runtime=letta");

  assert.deepEqual(calls, ["runtime=codex"]);

  pending.get("runtime=codex")?.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ["runtime=codex", "runtime=letta"]);
  assert.equal(pending.has("runtime=gemini"), false);

  pending.get("runtime=letta")?.resolve();
  await queue.waitForIdle();
});

test("serialized dispatcher preference patch queue keeps different scopes isolated", async () => {
  type Payload = {
    projectId: string;
    bridgeId: string | null;
    threadId: string;
    value: string;
  };

  const calls: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferredPromise<void>>>();
  const scopePending = new Map<string, boolean>();
  const queue = createSerializedDispatcherPreferencePatchQueue<Payload, string>({
    getScopeKey: (payload) => dispatcherPreferencePatchScopeKey(payload),
    send: async (payload) => {
      calls.push(payload.value);
      const gate = deferredPromise<void>();
      pending.set(payload.value, gate);
      await gate.promise;
      return payload.value;
    },
    onPendingChange: (scopeKey, isPending) => {
      scopePending.set(scopeKey, isPending);
    },
  });
  const scopeA = dispatcherPreferencePatchScopeKey({
    projectId: "demo-a",
    bridgeId: null,
    threadId: "thread-a",
  });
  const scopeB = dispatcherPreferencePatchScopeKey({
    projectId: "demo-b",
    bridgeId: "bridge-b",
    threadId: "thread-b",
  });

  queue.schedule({
    projectId: "demo-a",
    bridgeId: null,
    threadId: "thread-a",
    value: "scope-a:first",
  });
  queue.schedule({
    projectId: "demo-b",
    bridgeId: "bridge-b",
    threadId: "thread-b",
    value: "scope-b:first",
  });
  queue.schedule({
    projectId: "demo-a",
    bridgeId: null,
    threadId: "thread-a",
    value: "scope-a:latest",
  });
  queue.schedule({
    projectId: "demo-b",
    bridgeId: "bridge-b",
    threadId: "thread-b",
    value: "scope-b:latest",
  });

  assert.deepEqual(calls, ["scope-a:first", "scope-b:first"]);
  assert.equal(queue.isPending(scopeA), true);
  assert.equal(queue.isPending(scopeB), true);
  assert.equal(scopePending.get(scopeA), true);
  assert.equal(scopePending.get(scopeB), true);

  pending.get("scope-a:first")?.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["scope-a:first", "scope-b:first", "scope-a:latest"]);

  pending.get("scope-a:latest")?.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.isPending(scopeA), false);
  assert.equal(queue.isPending(scopeB), true);
  assert.equal(scopePending.get(scopeA), false);

  pending.get("scope-b:first")?.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["scope-a:first", "scope-b:first", "scope-a:latest", "scope-b:latest"]);

  pending.get("scope-b:latest")?.resolve();
  await queue.waitForIdle();
  assert.equal(queue.isPending(scopeB), false);
  assert.equal(scopePending.get(scopeB), false);
});

test("serialized dispatcher preference patch queue clears scoped pending and recovers after errors", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const pendingByScope = new Map<string, boolean>();
  const queue = createSerializedDispatcherPreferencePatchQueue<string, string>({
    getScopeKey: () => "demo-thread",
    send: async (payload) => {
      calls.push(payload);
      if (payload === "first") {
        throw new Error("boom");
      }
      return payload;
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    onPendingChange: (scopeKey, pending) => {
      pendingByScope.set(scopeKey, pending);
    },
  });

  queue.schedule("first");
  queue.schedule("second");
  await queue.waitForIdle();

  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(errors, ["boom"]);
  assert.equal(pendingByScope.get("demo-thread"), false);
});

test("serialized dispatcher preference patch queue dispose clears in-flight pending state once the request settles", async () => {
  const gate = deferredPromise<string>();
  const pendingByScope = new Map<string, boolean>();
  const queue = createSerializedDispatcherPreferencePatchQueue<string, string>({
    getScopeKey: () => "demo-thread",
    send: async (payload) => {
      await gate.promise;
      return payload;
    },
    onPendingChange: (scopeKey, pending) => {
      pendingByScope.set(scopeKey, pending);
    },
  });

  queue.schedule("first");
  await Promise.resolve();

  assert.equal(queue.isPending("demo-thread"), true);
  assert.equal(pendingByScope.get("demo-thread"), true);

  queue.dispose();
  assert.equal(queue.isPending("demo-thread"), false);
  assert.equal(pendingByScope.get("demo-thread"), false);

  gate.resolve("done");
  await Promise.resolve();
  await Promise.resolve();
  await queue.waitForIdle();

  assert.equal(queue.isPending("demo-thread"), false);
  assert.equal(pendingByScope.get("demo-thread"), false);
});

test("serialized dispatcher preference patch queue lets a stale A success avoid visually rolling back optimistic B while B is pending", async () => {
  const scope = dispatcherPreferencePatchScopeKey({
    projectId: "demo",
    bridgeId: null,
    threadId: "thread-1",
  });
  const pending = new Map<string, ReturnType<typeof deferredPromise<string>>>();
  const queue = createSerializedDispatcherPreferencePatchQueue<string, string>({
    getScopeKey: () => scope,
    send: async (payload) => {
      const gate = deferredPromise<string>();
      pending.set(payload, gate);
      return await gate.promise;
    },
  });

  let confirmedThread = "server:initial";
  let visibleControls = confirmedThread;

  const reconcileConfirmedThread = () => {
    if (!queue.isPending(scope)) {
      visibleControls = confirmedThread;
    }
  };

  const updateControl = (nextValue: string) => {
    visibleControls = nextValue;
    queue.schedule(nextValue);
  };

  updateControl("server:A");
  updateControl("server:B");
  assert.equal(visibleControls, "server:B");

  pending.get("server:A")?.resolve("server:A");
  await Promise.resolve();
  await Promise.resolve();
  confirmedThread = "server:A";
  reconcileConfirmedThread();

  assert.equal(queue.isPending(scope), true);
  assert.equal(visibleControls, "server:B");

  pending.get("server:B")?.resolve("server:B");
  await queue.waitForIdle();
  confirmedThread = "server:B";
  reconcileConfirmedThread();

  assert.equal(visibleControls, "server:B");
});

test("serialized dispatcher preference patch queue restores the last confirmed thread after the final optimistic patch errors", async () => {
  const scope = dispatcherPreferencePatchScopeKey({
    projectId: "demo",
    bridgeId: null,
    threadId: "thread-1",
  });
  const pending = new Map<string, ReturnType<typeof deferredPromise<string>>>();
  let confirmedThread = "server:initial";
  let visibleControls = confirmedThread;
  const queue = createSerializedDispatcherPreferencePatchQueue<string, string>({
    getScopeKey: () => scope,
    send: async (payload) => {
      const gate = deferredPromise<string>();
      pending.set(payload, gate);
      return await gate.promise;
    },
    onSuccess: (thread) => {
      confirmedThread = thread;
    },
    onError: () => {
      visibleControls = confirmedThread;
    },
  });

  visibleControls = "server:A";
  queue.schedule("server:A");
  pending.get("server:A")?.resolve("server:A");
  await queue.waitForIdle();
  visibleControls = confirmedThread;

  visibleControls = "server:B";
  queue.schedule("server:B");
  pending.get("server:B")?.reject(new Error("boom"));
  await queue.waitForIdle();

  assert.equal(confirmedThread, "server:A");
  assert.equal(visibleControls, "server:A");
});

test("dispatcher preference patch requests surface a bounded timeout error", async () => {
  const request: DispatcherPreferencePatchRequest = {
    projectId: "demo",
    bridgeId: "bridge-1",
    threadId: "thread-1",
    dispatcherAgent: "codex",
    dispatcherModel: "gpt-5.4",
    dispatcherReasoningEffort: "high",
    implementationAgent: "codex",
    implementationModel: "gpt-5.4",
    implementationReasoningEffort: "high",
  };

  await assert.rejects(
    sendDispatcherPreferencePatchRequest(request, {
      timeoutMs: 5,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }
        if (signal.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
    }),
    /Updating dispatcher preferences timed out after 5ms\. The backend may be busy\./,
  );
});
