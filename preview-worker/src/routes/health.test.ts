import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { SessionStore } from "../sessions/SessionStore.js";
import { registerHealthRoutes, resolveBuildSha } from "./health.js";

test("resolveBuildSha exposes the injected build identity and defaults to unknown", () => {
  assert.equal(resolveBuildSha({ CONDUCTOR_BUILD_SHA: "  abc123  " }), "abc123");
  assert.equal(resolveBuildSha({}), "unknown");
  assert.equal(resolveBuildSha({ CONDUCTOR_BUILD_SHA: "  " }), "unknown");
});

test("health reports the exact preview worker build identity", async () => {
  const app = Fastify();
  registerHealthRoutes(app, new SessionStore(60_000), "commit-deadbeef");

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.buildSha, "commit-deadbeef");
  assert.equal(body.sessions, 0);
  assert.equal(typeof body.uptimeSeconds, "number");
  await app.close();
});
