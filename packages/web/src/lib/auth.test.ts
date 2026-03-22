import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  buildHostedSignInPath,
  buildHostedSignInRedirectUrl,
  buildSignInPath,
  getDefaultPostSignInRedirectTarget,
  getDashboardAccess,
  guardApiActionAccess,
  resolvePostSignInRedirectTarget,
} from "./auth";

const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;

function resetDashboardAuthEnv(): void {
  process.env.CO_CONFIG_PATH = "/tmp/conductor-auth-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
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

test("getDashboardAccess uses the forwarded host for hosted auth checks", async () => {
  resetDashboardAuthEnv();
  process.env.CONDUCTOR_REQUIRE_AUTH = "true";

  const access = await getDashboardAccess(new Request("http://127.0.0.1:3000/api/access", {
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "preview.conductross.com",
      "x-forwarded-proto": "https",
    },
  }));

  assert.equal(access.ok, false);
  assert.equal(access.reason, "Authentication is required for non-local dashboard access");
});

test("guardApiActionAccess allows tunneled same-origin action requests via forwarded host", () => {
  const request = new NextRequest("http://127.0.0.1:3000/api/preferences", {
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
  const request = new NextRequest("http://127.0.0.1:3000/api/preferences", {
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

test("resolvePostSignInRedirectTarget preserves bridge claim redirects", () => {
  assert.equal(
    resolvePostSignInRedirectTarget("/bridge/connect?claim=claim_123"),
    "/bridge/connect?claim=claim_123",
  );
});

test("resolvePostSignInRedirectTarget avoids sending users back into sign-in", () => {
  assert.equal(resolvePostSignInRedirectTarget("/sign-in"), "/");
  assert.equal(resolvePostSignInRedirectTarget("/sign-in/sso-callback"), "/");
  assert.equal(resolvePostSignInRedirectTarget("https://evil.example.com"), "/");
});

test("resolvePostSignInRedirectTarget falls back to bridge pairing for paired-device flows", () => {
  const defaultRedirectTarget = getDefaultPostSignInRedirectTarget(true);
  assert.equal(defaultRedirectTarget, "/bridge/connect");
  assert.equal(resolvePostSignInRedirectTarget(undefined, undefined, defaultRedirectTarget), "/bridge/connect");
  assert.equal(resolvePostSignInRedirectTarget("/sign-in", undefined, defaultRedirectTarget), "/bridge/connect");
  assert.equal(
    resolvePostSignInRedirectTarget("https://evil.example.com", "https://preview.conductross.com", defaultRedirectTarget),
    "/bridge/connect",
  );
});

test("resolvePostSignInRedirectTarget preserves claim-aware defaults for device-first pairing", () => {
  const defaultRedirectTarget = "/bridge/connect?claim=claim_123";
  assert.equal(
    resolvePostSignInRedirectTarget(undefined, "https://preview.conductross.com", defaultRedirectTarget),
    "/bridge/connect?claim=claim_123",
  );
  assert.equal(
    resolvePostSignInRedirectTarget("/sign-in/sso-callback", "https://preview.conductross.com", defaultRedirectTarget),
    "/bridge/connect?claim=claim_123",
  );
});

test("resolvePostSignInRedirectTarget accepts same-origin absolute callback targets", () => {
  assert.equal(
    resolvePostSignInRedirectTarget(
      "https://preview.conductross.com/bridge/connect?claim=claim_123",
      "https://preview.conductross.com",
    ),
    "/bridge/connect?claim=claim_123",
  );
});

test("buildSignInPath includes redirect_url only when needed", () => {
  assert.equal(buildSignInPath("/bridge/connect?claim=claim_123"), "/sign-in?redirect_url=%2Fbridge%2Fconnect%3Fclaim%3Dclaim_123");
  assert.equal(buildSignInPath("/sign-in"), "/sign-in");
  assert.equal(buildSignInPath(undefined), "/sign-in");
  assert.equal(buildSignInPath(undefined, "/bridge/connect"), "/sign-in?redirect_url=%2Fbridge%2Fconnect");
});

test("buildHostedSignInPath includes redirect_url only when needed", () => {
  assert.equal(
    buildHostedSignInPath("/bridge/connect?claim=claim_123"),
    "/sign-in/hosted?redirect_url=%2Fbridge%2Fconnect%3Fclaim%3Dclaim_123",
  );
  assert.equal(buildHostedSignInPath("/sign-in"), "/sign-in/hosted");
  assert.equal(buildHostedSignInPath(undefined), "/sign-in/hosted");
});

test("buildHostedSignInRedirectUrl targets the configured hosted Clerk page", () => {
  assert.equal(
    buildHostedSignInRedirectUrl(
      "https://accounts.conductross.com/sign-in",
      "https://preview.conductross.com",
      "/bridge/connect?claim=claim_123",
    ),
    "https://accounts.conductross.com/sign-in?redirect_url=https%3A%2F%2Fpreview.conductross.com%2Fbridge%2Fconnect%3Fclaim%3Dclaim_123",
  );
});

test("buildHostedSignInRedirectUrl avoids redirect loops back to the local sign-in route", () => {
  assert.equal(
    buildHostedSignInRedirectUrl("/sign-in", "https://preview.conductross.com", "/"),
    null,
  );
});
