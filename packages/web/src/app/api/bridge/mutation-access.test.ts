import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { DELETE as DELETE_BRIDGE } from "./bridges/[bridgeId]/route";
import { DELETE as DELETE_DEVICE } from "./devices/[deviceId]/route";
import { POST as COMPLETE_CLAIM } from "./devices/claims/complete/route";
import { POST as CREATE_DEVICE_CODE } from "./devices/code/route";
import { POST as CREATE_RELAY_TERMINAL } from "../sessions/[id]/terminal/relay/route";
import { GET as GET_TERMINAL_TOKEN } from "../sessions/[id]/terminal/token/route";
import { GET as GET_TTYD } from "../sessions/[id]/terminal/ttyd/route";
import { GET as GET_TTYD_TOKEN } from "../sessions/[id]/terminal/ttyd/token/route";
import { GET as GET_TTYD_WS } from "../sessions/[id]/terminal/ttyd/ws/route";

const env = process.env as Record<string, string | undefined>;
const TEST_ENV_KEYS = [
  "CO_CONFIG_PATH",
  "CONDUCTOR_WORKSPACE",
  "CONDUCTOR_TRUST_AUTH_HEADERS",
  "CONDUCTOR_TRUST_AUTH_PROVIDER",
  "CONDUCTOR_CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CONDUCTOR_CLOUDFLARE_ACCESS_AUDIENCE",
  "CONDUCTOR_ACCESS_DEFAULT_ROLE",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CONDUCTOR_BACKEND_URL",
  "CONDUCTOR_BRIDGE_RELAY_URL",
  "RELAY_JWT_SECRET",
] as const;

test(
  "bridge mutations and interactive terminals reject viewers while preserving operator pairing",
  { concurrency: false },
  async () => {
    const originalEnv = new Map(
      TEST_ENV_KEYS.map((key) => [key, env[key]] as const)
    );
    const originalFetch = globalThis.fetch;
    const teamDomain = "bridge-mutation-test.cloudflareaccess.com";
    const audience = "bridge-mutation-test-audience";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "bridge-mutation-test";
    const assertion = await new SignJWT({ email: "viewer@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuedAt()
      .setIssuer(`https://${teamDomain}`)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(privateKey);

    env.CO_CONFIG_PATH =
      "/tmp/conductor-bridge-mutation-test-config-does-not-exist.yaml";
    env.CONDUCTOR_WORKSPACE = "";
    env.CONDUCTOR_TRUST_AUTH_HEADERS = "true";
    env.CONDUCTOR_TRUST_AUTH_PROVIDER = "cloudflare-access";
    env.CONDUCTOR_CLOUDFLARE_ACCESS_TEAM_DOMAIN = teamDomain;
    env.CONDUCTOR_CLOUDFLARE_ACCESS_AUDIENCE = audience;
    env.CONDUCTOR_ACCESS_DEFAULT_ROLE = "viewer";
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "";
    env.CLERK_SECRET_KEY = "";
    env.CONDUCTOR_BACKEND_URL = "";
    env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";
    env.RELAY_JWT_SECRET = "bridge-mutation-test-secret-at-least-32-bytes";

    let relayCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === `https://${teamDomain}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }

      relayCalls += 1;
      assert.equal(url, "https://relay.example.com/api/devices/code");
      assert.equal(init?.method, "POST");
      return Response.json({ code: "pair-123" });
    }) as typeof fetch;

    const request = (pathname: string, method: "GET" | "POST" | "DELETE") =>
      new NextRequest(`https://dashboard.example.com${pathname}`, {
        method,
        headers: {
          "Cf-Access-Jwt-Assertion": assertion,
          "Cf-Access-Authenticated-User-Email": "viewer@example.com",
          origin: "https://dashboard.example.com",
          "sec-fetch-site": "same-origin",
        },
      });

    try {
      const bridgeSessionId = "bridge:bridge-1:session-1";
      const bridgeSessionPath = "bridge%3Abridge-1%3Asession-1";
      const sessionContext = {
        params: Promise.resolve({ id: bridgeSessionId }),
      };
      const viewerResponses = await Promise.all([
        CREATE_DEVICE_CODE(request("/api/bridge/devices/code", "POST")),
        COMPLETE_CLAIM(request("/api/bridge/devices/claims/complete", "POST")),
        DELETE_DEVICE(request("/api/bridge/devices/device-1", "DELETE"), {
          params: Promise.resolve({ deviceId: "device-1" }),
        }),
        DELETE_BRIDGE(request("/api/bridge/bridges/bridge-1", "DELETE"), {
          params: Promise.resolve({ bridgeId: "bridge-1" }),
        }),
        GET_TERMINAL_TOKEN(
          request(`/api/sessions/${bridgeSessionPath}/terminal/token`, "GET"),
          sessionContext
        ),
        GET_TTYD(
          request(`/api/sessions/${bridgeSessionPath}/terminal/ttyd`, "GET"),
          sessionContext
        ),
        GET_TTYD_TOKEN(
          request(
            `/api/sessions/${bridgeSessionPath}/terminal/ttyd/token`,
            "GET"
          ),
          sessionContext
        ),
        GET_TTYD_WS(
          request(`/api/sessions/${bridgeSessionPath}/terminal/ttyd/ws`, "GET"),
          sessionContext
        ),
        CREATE_RELAY_TERMINAL(
          request(`/api/sessions/${bridgeSessionPath}/terminal/relay`, "POST"),
          sessionContext
        ),
      ]);

      for (const response of viewerResponses) {
        assert.equal(response.status, 403);
        const payload = (await response.json()) as { reason?: string };
        assert.equal(payload.reason, "Requires operator access");
      }
      assert.equal(relayCalls, 0);

      env.CONDUCTOR_ACCESS_DEFAULT_ROLE = "operator";
      const operatorTerminalResponse = await GET_TTYD(
        request(`/api/sessions/${bridgeSessionPath}/terminal/ttyd`, "GET"),
        sessionContext
      );
      assert.equal(operatorTerminalResponse.status, 307);
      assert.equal(
        operatorTerminalResponse.headers.get("location"),
        `https://dashboard.example.com/embed/terminal/${bridgeSessionPath}?bridgeId=bridge-1`
      );
      assert.equal(relayCalls, 0);

      const operatorResponse = await CREATE_DEVICE_CODE(
        request("/api/bridge/devices/code", "POST")
      );
      assert.equal(operatorResponse.status, 200);
      assert.equal(relayCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of originalEnv) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    }
  }
);
