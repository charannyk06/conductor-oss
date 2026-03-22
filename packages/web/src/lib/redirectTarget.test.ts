import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRedirectTarget } from "./redirectTarget";

test("sanitizeRedirectTarget only keeps safe local paths", () => {
  assert.equal(sanitizeRedirectTarget("/sessions/123"), "/sessions/123");
  assert.equal(sanitizeRedirectTarget("https://evil.example.com"), "/");
  assert.equal(sanitizeRedirectTarget("//evil.example.com"), "/");
  assert.equal(sanitizeRedirectTarget(undefined), "/");
});
