import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, resolveRoleForEmail, roleMeetsRequirement } from "./accessControl";

test("resolveRoleForEmail prefers the highest matching bound role", () => {
  const resolution = resolveRoleForEmail("lead@example.com", {
    roles: {
      viewers: ["lead@example.com"],
      admins: ["lead@example.com"],
    },
  });

  assert.equal(resolution.role, "admin");
  assert.equal(resolution.matchedBinding, true);
});

test("resolveRoleForEmail falls back to the configured default role", () => {
  const resolution = resolveRoleForEmail("member@example.com", {
    defaultRole: "viewer",
  });

  assert.equal(resolution.role, "viewer");
  assert.equal(resolution.matchedBinding, false);
});

test("resolveRoleForEmail denies unmatched users when explicit bindings exist", () => {
  const resolution = resolveRoleForEmail("outsider@example.com", {
    roles: {
      operators: ["operator@example.com"],
    },
  });

  assert.equal(resolution.role, null);
});

test("roleMeetsRequirement enforces the viewer/operator/admin hierarchy", () => {
  assert.equal(roleMeetsRequirement("admin", "operator"), true);
  assert.equal(roleMeetsRequirement("operator", "viewer"), true);
  assert.equal(roleMeetsRequirement("viewer", "operator"), false);
});

test("isLoopbackHost recognizes local dashboard hosts", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("app.example.com"), false);
});
