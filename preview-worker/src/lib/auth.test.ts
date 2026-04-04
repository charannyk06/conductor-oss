import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import { registerAuth, requireRequestApiKey } from "./auth.js";

test("health requests skip bearer auth", async () => {
  const app = Fastify();
  registerAuth(app, "expected-secret");
  app.get("/health", async () => ({ ok: true }));

  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  await app.close();
});

async function buildSessionApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  registerAuth(app, "expected-secret");
  app.get("/sessions", async () => ({ ok: true }));
  return app;
}

test("non-health routes reject requests without Authorization", async () => {
  const app = await buildSessionApp();
  try {
    const res = await app.inject({ method: "GET", url: "/sessions" });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("non-health routes reject a wrong Bearer token", async () => {
  const app = await buildSessionApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("non-health routes accept the configured Bearer token", async () => {
  const app = await buildSessionApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: "Bearer expected-secret" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    await app.close();
  }
});

test("authenticated requests expose apiKey via requireRequestApiKey", async () => {
  const app = Fastify();
  registerAuth(app, "expected-secret");
  app.get("/whoami", async (request) => ({ key: requireRequestApiKey(request) }));

  const res = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: { authorization: "Bearer expected-secret" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { key: "expected-secret" });
  await app.close();
});

test("requireRequestApiKey throws when auth context is missing", () => {
  assert.throws(
    () => requireRequestApiKey({ apiKey: undefined } as Parameters<typeof requireRequestApiKey>[0]),
    /API key context is missing/,
  );
});
