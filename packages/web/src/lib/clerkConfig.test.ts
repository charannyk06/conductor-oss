import assert from "node:assert/strict";
import test from "node:test";
import { resolveClerkConfiguration, resolveClerkFrontendApiUrl } from "./clerkConfig";

const originalPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const originalSecretKey = process.env.CLERK_SECRET_KEY;
const originalFrontendApiUrl = process.env.CLERK_FAPI_URL;
const originalAllowedOrigins = process.env.CONDUCTOR_ALLOWED_ORIGINS;

function restoreClerkEnv(): void {
  if (originalPublishableKey === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalPublishableKey;
  }

  if (originalSecretKey === undefined) {
    delete process.env.CLERK_SECRET_KEY;
  } else {
    process.env.CLERK_SECRET_KEY = originalSecretKey;
  }

  if (originalFrontendApiUrl === undefined) {
    delete process.env.CLERK_FAPI_URL;
  } else {
    process.env.CLERK_FAPI_URL = originalFrontendApiUrl;
  }

  if (originalAllowedOrigins === undefined) {
    delete process.env.CONDUCTOR_ALLOWED_ORIGINS;
  } else {
    process.env.CONDUCTOR_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
}

test.afterEach(() => {
  restoreClerkEnv();
});

test.after(() => {
  restoreClerkEnv();
});

test("resolveClerkConfiguration allows development keys on loopback hosts", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_loopback";
  process.env.CLERK_SECRET_KEY = "sk_test_loopback";

  const configuration = resolveClerkConfiguration("127.0.0.1", "http://127.0.0.1:3000");

  assert.equal(configuration.enabled, true);
  assert.equal(configuration.reason, null);
  assert.equal(configuration.proxyUrl, null);
});

test("resolveClerkConfiguration rejects development keys on hosted domains", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_hosted";
  process.env.CLERK_SECRET_KEY = "sk_test_hosted";

  const configuration = resolveClerkConfiguration(
    "conductor-dashboard-seven.vercel.app",
    "https://conductor-dashboard-seven.vercel.app",
  );

  assert.equal(configuration.enabled, false);
  assert.equal(configuration.reason, "hosted-development-keys");
});

test("resolveClerkConfiguration requires a publishable key before rendering Clerk", () => {
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;

  const configuration = resolveClerkConfiguration("localhost", "http://localhost:3000");

  assert.equal(configuration.enabled, false);
  assert.equal(configuration.reason, "missing-publishable-key");
});

test("resolveClerkConfiguration allows live keys on hosted domains", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_hosted";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";

  const configuration = resolveClerkConfiguration(
    "conductor-dashboard-seven.vercel.app",
    "https://conductor-dashboard-seven.vercel.app",
  );

  assert.equal(configuration.enabled, true);
  assert.equal(configuration.reason, null);
  assert.equal(configuration.secretKeyAvailable, true);
  assert.equal(configuration.proxyUrl, "https://conductor-dashboard-seven.vercel.app/__clerk");
  assert.equal(
    configuration.clerkJSUrl,
    "https://conductor-dashboard-seven.vercel.app/__clerk/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
  );
  assert.deepEqual(configuration.allowedRedirectOrigins, ["https://conductor-dashboard-seven.vercel.app"]);
});

test("resolveClerkConfiguration keeps the hosted sign-in surface available without the server key", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_hosted";
  delete process.env.CLERK_SECRET_KEY;

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.equal(configuration.enabled, true);
  assert.equal(configuration.reason, null);
  assert.equal(configuration.secretKeyAvailable, false);
});

test("resolveClerkConfiguration uses stable configured origins for redirect validation", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_hosted";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  process.env.CONDUCTOR_ALLOWED_ORIGINS = "https://app.conductross.com, preview.conductross.com";

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.deepEqual(configuration.allowedRedirectOrigins, [
    "https://preview.conductross.com",
    "https://app.conductross.com",
  ]);
});

test("resolveClerkFrontendApiUrl derives the instance host from the Clerk publishable key", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  delete process.env.CLERK_FAPI_URL;

  assert.equal(resolveClerkFrontendApiUrl(), "https://clerk.conductross.com");
});

test("resolveClerkFrontendApiUrl prefers the explicit environment override", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_FAPI_URL = "https://frontend-api.example.com/";

  assert.equal(resolveClerkFrontendApiUrl(), "https://frontend-api.example.com");
});
