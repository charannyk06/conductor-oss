import assert from "node:assert/strict";
import test from "node:test";
import { resolveClerkConfiguration, resolveClerkFrontendApiUrl } from "./clerkConfig";

const originalPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const originalSecretKey = process.env.CLERK_SECRET_KEY;
const originalFrontendApiUrl = process.env.CLERK_FAPI_URL;
const originalAllowedOrigins = process.env.CONDUCTOR_ALLOWED_ORIGINS;
const originalProxyUrl = process.env.NEXT_PUBLIC_CLERK_PROXY_URL;
const originalSignInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL;
const originalSignUpUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL;
const originalHostedSignInUrl = process.env.NEXT_PUBLIC_CLERK_HOSTED_SIGN_IN_URL;

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

  if (originalProxyUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PROXY_URL;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PROXY_URL = originalProxyUrl;
  }

  if (originalSignInUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL;
  } else {
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = originalSignInUrl;
  }

  if (originalSignUpUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL;
  } else {
    process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL = originalSignUpUrl;
  }

  if (originalHostedSignInUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_HOSTED_SIGN_IN_URL;
  } else {
    process.env.NEXT_PUBLIC_CLERK_HOSTED_SIGN_IN_URL = originalHostedSignInUrl;
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
  assert.equal(configuration.signInUrl, "/sign-in");
  assert.equal(configuration.signUpUrl, null);
  assert.equal(configuration.hostedSignInUrl, null);
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
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  delete process.env.NEXT_PUBLIC_CLERK_PROXY_URL;

  const configuration = resolveClerkConfiguration(
    "conductor-dashboard-seven.vercel.app",
    "https://conductor-dashboard-seven.vercel.app",
  );

  assert.equal(configuration.enabled, true);
  assert.equal(configuration.reason, null);
  assert.equal(configuration.secretKeyAvailable, true);
  assert.equal(configuration.proxyUrl, null);
  assert.equal(configuration.clerkJSUrl, null);
  assert.equal(configuration.signInUrl, "/sign-in");
  assert.equal(configuration.signUpUrl, null);
  assert.equal(configuration.hostedSignInUrl, null);
  assert.deepEqual(configuration.allowedRedirectOrigins, ["https://conductor-dashboard-seven.vercel.app"]);
});

test("resolveClerkConfiguration keeps the hosted sign-in surface available without the server key", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PROXY_URL;

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.equal(configuration.enabled, true);
  assert.equal(configuration.reason, null);
  assert.equal(configuration.secretKeyAvailable, false);
  assert.equal(configuration.signInUrl, "/sign-in");
});

test("resolveClerkConfiguration uses stable configured origins for redirect validation", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  process.env.CONDUCTOR_ALLOWED_ORIGINS = "https://app.conductross.com, preview.conductross.com";
  delete process.env.NEXT_PUBLIC_CLERK_PROXY_URL;

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.deepEqual(configuration.allowedRedirectOrigins, [
    "https://preview.conductross.com",
    "https://app.conductross.com",
  ]);
});

test("resolveClerkConfiguration prefers an explicit shared proxy path when configured", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  process.env.NEXT_PUBLIC_CLERK_PROXY_URL = "/__clerk/";

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.equal(configuration.proxyUrl, "/__clerk");
  assert.equal(configuration.clerkJSUrl, "/__clerk/npm/@clerk/clerk-js@5/dist/clerk.browser.js");
});

test("resolveClerkConfiguration preserves the path on absolute proxy URLs", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  process.env.NEXT_PUBLIC_CLERK_PROXY_URL = "https://app.conductross.com/__clerk/";

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.equal(configuration.proxyUrl, "https://app.conductross.com/__clerk");
  assert.equal(
    configuration.clerkJSUrl,
    "https://app.conductross.com/__clerk/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
  );
});

test("resolveClerkConfiguration exposes configured hosted sign-in and sign-up URLs", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  process.env.NEXT_PUBLIC_CLERK_HOSTED_SIGN_IN_URL = "https://accounts.conductross.com/sign-in/";
  process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL = "/sign-up/";

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.equal(configuration.signInUrl, "/sign-in");
  assert.equal(configuration.signUpUrl, "/sign-up");
  assert.equal(configuration.hostedSignInUrl, "https://accounts.conductross.com/sign-in");
});

test("resolveClerkConfiguration treats external sign-in urls as hosted fallback urls", () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY29uZHVjdHJvc3MuY29tJA";
  process.env.CLERK_SECRET_KEY = "sk_live_hosted";
  process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "https://accounts.conductross.com/sign-in/";

  const configuration = resolveClerkConfiguration("preview.conductross.com", "https://preview.conductross.com");

  assert.equal(configuration.signInUrl, "/sign-in");
  assert.equal(configuration.hostedSignInUrl, "https://accounts.conductross.com/sign-in");
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
