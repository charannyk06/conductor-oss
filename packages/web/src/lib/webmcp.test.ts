import assert from "node:assert/strict";
import test from "node:test";
import {
  detectWebMcpCompatibility,
  readBoundedString,
  registerWebMcpTools,
} from "./webmcp";

test("detectWebMcpCompatibility reports missing browser support cleanly", () => {
  const compatibility = detectWebMcpCompatibility(undefined);
  assert.equal(compatibility.supported, false);
  assert.equal(compatibility.modelContext, null);
  assert.match(compatibility.reason, /Document context is unavailable/i);
});

test("detectWebMcpCompatibility prefers document and supports the legacy navigator surface", () => {
  const documentContext = { registerTool() {} };
  const navigatorContext = { registerTool() {} };

  const preferred = detectWebMcpCompatibility(
    { modelContext: documentContext },
    { modelContext: navigatorContext },
  );
  const fallback = detectWebMcpCompatibility(
    {},
    { modelContext: navigatorContext },
  );

  assert.equal(preferred.modelContext, documentContext);
  assert.equal(fallback.supported, true);
  assert.equal(fallback.modelContext, navigatorContext);
});

test("registerWebMcpTools waits for every registration and cleanup aborts them", async () => {
  const registrations: AbortSignal[] = [];
  const toolNames: string[] = [];

  const dispose = await registerWebMcpTools(
    {
      registerTool(tool, options) {
        toolNames.push(tool.name);
        registrations.push(options?.signal ?? new AbortController().signal);
      },
    },
    [
      {
        name: "tool-a",
        description: "A",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => "{}",
      },
      {
        name: "tool-b",
        description: "B",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => "{}",
      },
    ],
  );

  assert.deepEqual(toolNames, ["tool-a", "tool-b"]);
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0], registrations[1]);
  assert.equal(registrations[0]?.aborted, false);

  dispose();

  assert.equal(registrations[0]?.aborted, true);
});

test("registerWebMcpTools rejects and aborts when one registration fails", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    registerWebMcpTools(
      {
        registerTool(_tool, options) {
          signal = options?.signal;
          return Promise.reject(new Error("registration denied"));
        },
      },
      [{
        name: "tool-a",
        description: "A",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => "{}",
      }],
    ),
    /registration denied/,
  );
  assert.equal(signal?.aborted, true);
});

test("readBoundedString trims valid input and rejects oversized input", () => {
  assert.deepEqual(readBoundedString("  valid  ", "prompt", 8), {
    value: "valid",
    error: null,
  });
  assert.deepEqual(readBoundedString("123456789", "prompt", 8), {
    value: null,
    error: "prompt must be at most 8 characters.",
  });
});
