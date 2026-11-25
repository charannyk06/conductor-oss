import assert from "node:assert/strict";
import { test } from "node:test";

import { isLoopbackBackendUrl } from "./localOnlyRoutes";

test("only backends on this machine count as local", () => {
  for (const local of [
    "http://127.0.0.1:4749",
    "http://127.0.0.1:4749/",
    "http://127.12.0.3:4749",
    "http://localhost:4748",
    "https://LOCALHOST:4748/api",
    "http://[::1]:4749",
  ]) {
    assert.equal(isLoopbackBackendUrl(local), true, local);
  }
  for (const remote of [
    "https://backend.example.com",
    "http://192.168.1.20:4749",
    "http://10.0.0.5:4749",
    "http://127.0.0.1.evil.test:4749",
    "http://localhost.evil.test",
    "http://0.0.0.0:4749",
    "not a url",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isLoopbackBackendUrl(remote), false, String(remote));
  }
});
