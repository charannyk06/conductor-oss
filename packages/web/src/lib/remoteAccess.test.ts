import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemoteAccessSummary } from "./remoteAccess";

test("resolveRemoteAccessSummary defaults to enterprise-only when no private or protected remote provider is active", () => {
  const summary = resolveRemoteAccessSummary({
    configuredPublicUrl: "https://dashboard.example.com",
  });

  assert.equal(summary.mode, "enterprise-only");
  assert.equal(summary.shareable, false);
  assert.equal(summary.connectUrl, null);
});

test("resolveRemoteAccessSummary exposes a private-network URL for managed Tailscale access", () => {
  const summary = resolveRemoteAccessSummary({
    configuredPublicUrl: "https://conductor.tailnet.ts.net",
    managedProvider: "tailscale",
    preferredProvider: "tailscale",
  });

  assert.equal(summary.mode, "private-network");
  assert.equal(summary.shareable, true);
  assert.equal(summary.connectUrl, "https://conductor.tailnet.ts.net");
});

test("resolveRemoteAccessSummary prompts to enable the private link when Tailscale is already connected", () => {
  const summary = resolveRemoteAccessSummary({
    preferredProvider: "tailscale",
    preferredProviderConnected: true,
  });

  assert.equal(summary.mode, "enterprise-only");
  assert.match(summary.description, /enable the managed private link/i);
  assert.deepEqual(summary.nextSteps, [
    "Enable the private link from Settings.",
    "Share the resulting private HTTPS URL only with operators who are already on your tailnet.",
  ]);
});

test("resolveRemoteAccessSummary refuses to share an observed public URL without auth", () => {
  const summary = resolveRemoteAccessSummary({
    observedPublicUrl: "https://dashboard.example.com",
  });

  assert.equal(summary.mode, "unsafe-public");
  assert.equal(summary.shareable, false);
  assert.equal(summary.connectUrl, null);
});

test("resolveRemoteAccessSummary ignores insecure configured public URLs until a secure provider is active", () => {
  const summary = resolveRemoteAccessSummary({
    configuredPublicUrl: "https://dashboard.example.com",
  });

  assert.equal(summary.mode, "enterprise-only");
  assert.equal(summary.shareable, false);
  assert.equal(summary.connectUrl, null);
});

test("resolveRemoteAccessSummary reuses the public URL when verified Cloudflare Access is enabled", () => {
  const summary = resolveRemoteAccessSummary({
    configuredPublicUrl: "https://dashboard.example.com",
    access: {
      trustedHeaders: {
        enabled: true,
        provider: "cloudflare-access",
        emailHeader: "Cf-Access-Authenticated-User-Email",
        jwtHeader: "Cf-Access-Jwt-Assertion",
        teamDomain: "acme.cloudflareaccess.com",
        audience: "cf-access-audience",
      },
    },
  });

  assert.equal(summary.mode, "cloudflare-access");
  assert.equal(summary.shareable, true);
  assert.equal(summary.connectUrl, "https://dashboard.example.com");
});

test("resolveRemoteAccessSummary blocks legacy generic trusted-header remote sharing", () => {
  const summary = resolveRemoteAccessSummary({
    observedPublicUrl: "https://dashboard.example.com",
    access: {
      trustedHeaders: {
        enabled: true,
        provider: "generic",
        emailHeader: "X-Remote-User",
        jwtHeader: "X-Remote-Jwt",
      },
    },
  });

  assert.equal(summary.mode, "generic-header");
  assert.equal(summary.shareable, false);
  assert.equal(summary.connectUrl, null);
  assert.match(summary.description, /no longer treats generic header passthrough/i);
});

test("resolveRemoteAccessSummary asks for a verified external URL before publishing an enterprise link", () => {
  const summary = resolveRemoteAccessSummary({
    access: {
      trustedHeaders: {
        enabled: true,
        provider: "cloudflare-access",
        emailHeader: "Cf-Access-Authenticated-User-Email",
        jwtHeader: "Cf-Access-Jwt-Assertion",
        teamDomain: "acme.cloudflareaccess.com",
        audience: "cf-access-audience",
      },
    },
  });

  assert.equal(summary.mode, "misconfigured");
  assert.equal(summary.shareable, false);
  assert.equal(summary.connectUrl, null);
  assert.match(summary.title, /needs a verified public url/i);
});
