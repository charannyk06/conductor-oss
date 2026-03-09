import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { resolveTrustedEdgeAuthConfig, verifyTrustedEdgeIdentity } from "./edgeAuth";

test("resolveTrustedEdgeAuthConfig defaults to verified Cloudflare Access mode", { concurrency: false }, () => {
  const config = resolveTrustedEdgeAuthConfig(null);

  assert.equal(config.enabled, false);
  assert.equal(config.provider, "cloudflare-access");
  assert.equal(config.emailHeader, "Cf-Access-Authenticated-User-Email");
  assert.equal(config.jwtHeader, "Cf-Access-Jwt-Assertion");
});

test("verifyTrustedEdgeIdentity rejects legacy generic trusted-header mode", { concurrency: false }, async () => {
  const result = await verifyTrustedEdgeIdentity(
    new Headers({
      "Cf-Access-Authenticated-User-Email": "dev@example.com",
    }),
    {
      trustedHeaders: {
        enabled: true,
        provider: "generic",
        emailHeader: "Cf-Access-Authenticated-User-Email",
      },
    },
  );

  assert.equal(result?.ok, false);
  assert.match(result?.reason ?? "", /removed/i);
});

test("verifyTrustedEdgeIdentity validates a Cloudflare Access JWT before trusting the email", { concurrency: false }, async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "edge-auth-test";

  const assertion = await new SignJWT({ email: "dev@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "edge-auth-test" })
    .setIssuedAt()
    .setIssuer("https://acme.cloudflareaccess.com")
    .setAudience("cf-access-audience")
    .setExpirationTime("5m")
    .sign(privateKey);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, "https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    const result = await verifyTrustedEdgeIdentity(
      new Headers({
        "Cf-Access-Jwt-Assertion": assertion,
        "Cf-Access-Authenticated-User-Email": "dev@example.com",
      }),
      {
        trustedHeaders: {
          enabled: true,
          provider: "cloudflare-access",
          teamDomain: "acme.cloudflareaccess.com",
          audience: "cf-access-audience",
          emailHeader: "Cf-Access-Authenticated-User-Email",
          jwtHeader: "Cf-Access-Jwt-Assertion",
        },
      },
    );

    assert.equal(result?.ok, true);
    assert.equal(result?.provider, "cloudflare-access");
    assert.equal(result?.ok ? result.email : null, "dev@example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
