import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { clearRemoteAccessRuntimeState } from "./remoteAccessRuntime";
import { getDashboardAccess, guardApiActionAccess } from "./auth";

const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;

function resetDashboardAuthEnv(): void {
  process.env.CO_CONFIG_PATH = "/tmp/conductor-auth-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  clearRemoteAccessRuntimeState();
}

test.afterEach(() => {
  resetDashboardAuthEnv();
});

test.after(() => {
  if (originalConfigPath === undefined) {
    delete process.env.CO_CONFIG_PATH;
  } else {
    process.env.CO_CONFIG_PATH = originalConfigPath;
  }

  if (originalWorkspace === undefined) {
    delete process.env.CONDUCTOR_WORKSPACE;
  } else {
    process.env.CONDUCTOR_WORKSPACE = originalWorkspace;
  }

  if (originalRequireAuth === undefined) {
    delete process.env.CONDUCTOR_REQUIRE_AUTH;
  } else {
    process.env.CONDUCTOR_REQUIRE_AUTH = originalRequireAuth;
  }

  clearRemoteAccessRuntimeState();
});

test("getDashboardAccess keeps loopback access available when remote auth is required", async () => {
  resetDashboardAuthEnv();
  process.env.CONDUCTOR_REQUIRE_AUTH = "true";

  const access = await getDashboardAccess(new Request("http://127.0.0.1:3000/api/access"));

  assert.equal(access.ok, true);
  assert.equal(access.provider, "local");
  assert.equal(access.role, "admin");
  assert.equal(access.email, "local");
});

test("getDashboardAccess still denies non-local requests without remote identity", async () => {
  resetDashboardAuthEnv();
  process.env.CONDUCTOR_REQUIRE_AUTH = "true";

  const access = await getDashboardAccess(new Request("https://dashboard.example.com/api/access"));

  assert.equal(access.ok, false);
  assert.equal(access.reason, "Authentication is required for non-local dashboard access");
});

test("guardApiActionAccess allows tunneled same-origin unlock requests via forwarded host", () => {
  const request = new NextRequest("http://127.0.0.1:3000/api/auth/session", {
    method: "POST",
    headers: {
      origin: "https://dashboard.example.com",
      referer: "https://dashboard.example.com/unlock",
      host: "127.0.0.1:3000",
      "x-forwarded-host": "dashboard.example.com",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  });

  const denied = guardApiActionAccess(request);
  assert.equal(denied, null);
});

test("guardApiActionAccess still blocks mismatched origins", () => {
  const request = new NextRequest("http://127.0.0.1:3000/api/auth/session", {
    method: "POST",
    headers: {
      origin: "https://evil.example.com",
      host: "127.0.0.1:3000",
      "x-forwarded-host": "dashboard.example.com",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "cross-site",
    },
  });

  const denied = guardApiActionAccess(request);
  assert.ok(denied);
  assert.equal(denied?.status, 403);
});
