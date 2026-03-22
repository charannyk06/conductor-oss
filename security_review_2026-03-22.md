# Security Review - 2026-03-22

## Executive Summary

I did not find a confirmed critical vulnerability in the default local-first deployment path, where the Rust backend stays loopback-only and relay/browser features are protected by explicit secrets or short-lived tokens.

The most serious issue I found is a high-severity authentication-bypass risk in hosted dashboard deployments: the Next.js auth layer treats `X-Forwarded-Host` as a trusted signal when deciding whether a request is "local", which can collapse the dashboard back to unauthenticated local-admin mode if that header is not overwritten by a trusted proxy. I also found a medium-severity hardening gap in the public relay pairing flow: pairing codes are short-lived but there is no observable rate limiting on the public redemption endpoint.

## High

### H-01: Hosted dashboard auth can be bypassed if forwarded host headers are not sanitized upstream

- Rule ID: H-01
- Severity: High
- Location:
  - `packages/web/src/lib/auth.ts:343`
  - `packages/web/src/lib/auth.ts:527`
  - `packages/web/src/lib/clerkConfig.ts:278`
  - `packages/web/src/lib/auth.ts:578`
- Evidence:

```ts
// packages/web/src/lib/auth.ts
async function currentHost(request?: Request): Promise<string> {
  if (request) {
    const forwardedHost = resolveRequestHostname(request.headers);
    if (forwardedHost) {
      return forwardedHost;
    }
```

```ts
// packages/web/src/lib/clerkConfig.ts
export function resolveRequestHostname(headerStore: Headers): string {
  const forwardedHost = headerStore.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || headerStore.get("host")?.trim() || "";
  return requestHost.split(":")[0]?.trim().toLowerCase() ?? "";
}
```

```ts
// packages/web/src/lib/auth.ts
if (!loopbackRequest) {
  return {
    ok: false,
    authenticated: false,
    reason: "Authentication is required for non-local dashboard access",
  };
}

if (requireAuth) return localAccess;
```

```ts
// packages/web/src/lib/auth.ts
function resolveExpectedActionHost(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    ...
    return parsed.host;
  }
```

- Impact: If a public dashboard deployment accepts client-controlled `X-Forwarded-Host` or `X-Forwarded-Proto`, an attacker can make the app believe the request is loopback-local and receive local-admin access without a valid remote identity.
- Why this matters:
  - `guardApiAccess()` relies on `getDashboardAccess()`, so the bypass reaches the protected API surface, not just page rendering.
  - The same header trust also feeds `guardApiActionAccess()`, so the origin check is built on the same untrusted forwarded-host assumption.
- Fix:
  - Do not treat `X-Forwarded-Host` or `X-Forwarded-Proto` as trustworthy unless the request is known to have passed through a trusted proxy boundary.
  - Prefer `request.nextUrl` or the raw `Host` header for local-vs-remote classification.
  - If forwarded headers are required in hosted mode, gate them behind an explicit `TRUST_PROXY_HEADERS=true` style setting and document the exact reverse-proxy overwrite requirement.
- Mitigation:
  - Ensure the external proxy strips user-supplied `X-Forwarded-*` headers and rewrites them itself.
  - Keep local-mode access disabled on any internet-facing deployment.
- False positive notes:
  - If every supported deployment path hard-overwrites `X-Forwarded-Host` and never forwards client values, exploitability drops sharply. I did not find an in-app guarantee of that property, so the risk remains in app code.

## Medium

### M-01: Public relay pairing redemption has no visible rate limiting

- Rule ID: M-01
- Severity: Medium
- Location:
  - `crates/conductor-relay/src/relay.rs:375`
  - `crates/conductor-relay/src/relay.rs:387`
  - `crates/conductor-relay/src/relay.rs:2042`
- Evidence:

```rust
// crates/conductor-relay/src/relay.rs
Router::new()
    ...
    .route("/api/devices/code", post(create_pairing_code))
    .route("/api/devices/pair", post(pair_device))
```

```rust
async fn pair_device(
    &self,
    request: DevicePairRequest,
) -> std::result::Result<DevicePairResponse, (StatusCode, &'static str)> {
    ...
    let pairing = inner
        .pairing_codes
        .remove(&code)
        .ok_or((StatusCode::NOT_FOUND, "Pairing code is invalid or expired."))?;
```

- Impact: A public relay can be brute-forced against active six-character pairing codes because the redemption endpoint is internet-facing and I did not find per-IP or per-code throttling around `pair_device`.
- Fix:
  - Add rate limiting keyed by source IP and pairing code prefix on `/api/devices/pair`.
  - Consider lengthening the pairing secret or requiring a second secret during redemption.
- Mitigation:
  - Restrict relay exposure behind an edge that enforces request throttling.
  - Alert on repeated invalid pairing attempts.
- False positive notes:
  - The code space is not tiny and codes expire after ten minutes, so this is a hardening issue rather than an immediate guaranteed compromise.

## Notes / Non-Findings

- I did not find a confirmed auth bypass in the Rust backend's default deployment path. The backend explicitly refuses non-loopback binding unless `CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND=true` is set in `crates/conductor-server/src/lib.rs:116`.
- I did not find a live terminal auth bypass in the ttyd flow. The general middleware exempts ttyd routes, but the route itself enforces a short-lived HMAC terminal token when access control is enabled in `crates/conductor-server/src/routes/terminal.rs:586` and `crates/conductor-server/src/routes/terminal.rs:1223`.
- I did not find a server-side preview SSRF in the browser automation path. Preview navigation is explicitly limited to localhost-style destinations in `packages/web/src/lib/devPreviewBrowser.ts:160`.
