import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBackendServeConfig,
  resolveLocalBackendUrl,
} from "./remoteAccessManager";

test("resolveLocalBackendUrl preserves explicit HTTP(S) backend URLs", () => {
  const previousBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
  const previousBackendPort = process.env.CONDUCTOR_BACKEND_PORT;

  process.env.CONDUCTOR_BACKEND_URL = "https://api.example.com/internal";
  delete process.env.CONDUCTOR_BACKEND_PORT;

  try {
    assert.equal(
      resolveLocalBackendUrl(),
      "https://api.example.com/internal",
    );
  } finally {
    if (previousBackendUrl === undefined) {
      delete process.env.CONDUCTOR_BACKEND_URL;
    } else {
      process.env.CONDUCTOR_BACKEND_URL = previousBackendUrl;
    }

    if (previousBackendPort === undefined) {
      delete process.env.CONDUCTOR_BACKEND_PORT;
    } else {
      process.env.CONDUCTOR_BACKEND_PORT = previousBackendPort;
    }
  }
});

test("resolveBackendServeConfig preserves full HTTPS backend targets", () => {
  assert.deepEqual(
    resolveBackendServeConfig("https://api.example.com/internal"),
    {
      port: 443,
      target: "https://api.example.com/internal",
    },
  );

  assert.deepEqual(
    resolveBackendServeConfig("https://localhost/api"),
    {
      port: 443,
      target: "https://localhost/api",
    },
  );
});

test("resolveBackendServeConfig normalizes truly local shorthand inputs", () => {
  assert.deepEqual(
    resolveBackendServeConfig("127.0.0.1:4749"),
    {
      port: 4749,
      target: "http://127.0.0.1:4749/",
    },
  );

  assert.deepEqual(
    resolveBackendServeConfig("4749"),
    {
      port: 4749,
      target: "http://127.0.0.1:4749",
    },
  );

  assert.equal(resolveBackendServeConfig("api.example.com"), null);
});
