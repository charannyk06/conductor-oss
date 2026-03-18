import assert from "node:assert/strict";
import test from "node:test";
import { requireRustBackendUrl, resolveRustBackendUrl } from "./backendUrl";

const env = process.env as Record<string, string | undefined>;
const previousBackendUrl = env.CONDUCTOR_BACKEND_URL;
const previousBackendPort = env.CONDUCTOR_BACKEND_PORT;
const previousNodeEnv = env.NODE_ENV;

function restoreEnv(): void {
  if (previousBackendUrl === undefined) {
    delete env.CONDUCTOR_BACKEND_URL;
  } else {
    env.CONDUCTOR_BACKEND_URL = previousBackendUrl;
  }

  if (previousBackendPort === undefined) {
    delete env.CONDUCTOR_BACKEND_PORT;
  } else {
    env.CONDUCTOR_BACKEND_PORT = previousBackendPort;
  }

  if (previousNodeEnv === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = previousNodeEnv;
  }
}

test.afterEach(() => {
  restoreEnv();
});

test("resolveRustBackendUrl prefers explicit backend url", () => {
  env.CONDUCTOR_BACKEND_URL = "https://api.example.com/internal";
  delete env.CONDUCTOR_BACKEND_PORT;
  env.NODE_ENV = "development";

  assert.equal(resolveRustBackendUrl(), "https://api.example.com/internal");
});

test("resolveRustBackendUrl falls back to configured backend port", () => {
  delete env.CONDUCTOR_BACKEND_URL;
  env.CONDUCTOR_BACKEND_PORT = "5858";
  env.NODE_ENV = "development";

  assert.equal(resolveRustBackendUrl(), "http://127.0.0.1:5858");
});

test("resolveRustBackendUrl falls back to local dev default during development", () => {
  delete env.CONDUCTOR_BACKEND_URL;
  delete env.CONDUCTOR_BACKEND_PORT;
  env.NODE_ENV = "development";

  assert.equal(resolveRustBackendUrl(), "http://127.0.0.1:4749");
});

test("requireRustBackendUrl still fails outside development without configuration", () => {
  delete env.CONDUCTOR_BACKEND_URL;
  delete env.CONDUCTOR_BACKEND_PORT;
  env.NODE_ENV = "test";

  assert.throws(() => requireRustBackendUrl(), /Rust backend URL is not configured/);
});
