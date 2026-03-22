# Security Review Report

## Executive Summary

I found two critical relay-layer issues and one additional high-risk weakness.

The relay is the main problem area. It is explicitly internet-facing by default (`0.0.0.0:8080`), but several privileged endpoints trust caller-supplied headers as proof of dashboard identity, and share-link handling exposes active share URLs without authentication while failing to enforce the requested session scope. In practice, a remote attacker can impersonate dashboard users, enumerate paired devices, proxy requests into a victim laptop's local backend, and, when a share exists, read data well beyond the intended shared session.

Rust workspace tests were run with `cargo test --workspace` and passed. This review was code-driven and focused on critical security impact, not feature correctness.

## Critical Findings

### COND-SEC-001

- Severity: Critical
- Title: Public relay trusts forgeable `x-conductor-*` headers as authentication
- Location:
  - `crates/conductor-relay/src/relay.rs:350`
  - `crates/conductor-relay/src/relay.rs:360`
  - `crates/conductor-relay/src/relay.rs:451`
  - `crates/conductor-relay/src/relay.rs:527`
  - `crates/conductor-relay/src/relay.rs:633`
  - `crates/conductor-relay/src/relay.rs:2393`
  - `crates/conductor-relay/src/relay.rs:424`
- Evidence:
  - The relay binds to `0.0.0.0:8080` by default and registers privileged device-management routes directly on that public server.
  - Privileged handlers call `resolve_proxy_user_id(&headers)` and accept any request with `x-conductor-proxy-authorized: true` plus `x-conductor-access-email` or `x-bridge-user-id`.
  - There is no signature, shared secret, mTLS check, loopback restriction, or reverse-proxy allowlist protecting those headers.
  - `/api/bridges` is also unauthenticated and publishes `bridge.user_id` values publicly.
- Impact:
  - A remote attacker can forge dashboard identity, impersonate users, create pairing codes, list victim devices, proxy requests through a paired device into its local backend, create relay-backed terminal sessions, and delete devices.
  - Because `/api/bridges` leaks connected `user_id` values, the relay itself helps attackers discover impersonation targets.
- Fix:
  - Remove header-based trust from the public relay.
  - Require a cryptographically verifiable relay-to-dashboard credential on every privileged relay route, such as a signed service JWT with audience/issuer validation or mTLS between dashboard and relay.
  - Treat `x-conductor-*` headers as advisory only after a trusted upstream is authenticated.
  - Protect `/api/bridges` with authenticated access or remove user identifiers from its response.
- Mitigation:
  - Until fixed, do not expose the relay to the internet.
  - Bind the relay to loopback or place it behind a trusted reverse proxy that strips incoming `x-conductor-*` headers and injects its own authenticated identity.
- False positive notes:
  - I did not find any app-layer check that would neutralize forged headers before they reach the relay handlers.

### COND-SEC-002

- Severity: Critical
- Title: Share links are publicly enumerable and not scoped to the requested session
- Location:
  - `crates/conductor-relay/src/relay.rs:385`
  - `crates/conductor-relay/src/relay.rs:798`
  - `crates/conductor-relay/src/relay.rs:871`
  - `crates/conductor-relay/src/relay.rs:980`
  - `crates/conductor-relay/src/relay.rs:1465`
  - `bridge-cmd/relay/client.go:832`
  - `bridge-cmd/relay/client.go:1114`
- Evidence:
  - `/api/shares` is registered with unauthenticated `GET`, and `list_shares` returns every active `share_id` and `browser_url`.
  - `delete_share` is also unauthenticated.
  - `create_share` stores a `session_scope`, but `resolve_browser_connection` ignores it and authorizes the browser connection solely by looking up the share and returning its underlying `bridge_token`.
  - `route_browser_message` then forwards read-only `FileBrowse`, `ApiRequest` with safe methods, and `PreviewRequest` messages to the bridge without any session-scope check.
  - On the paired-device Go bridge runtime, `FileBrowse` lists arbitrary directories and `ApiRequest` proxies directly into the local Conductor backend on `127.0.0.1:4749`.
- Impact:
  - Any unauthenticated attacker who can reach the relay can enumerate active share links, attach to them, browse the paired machine's filesystem metadata, and send arbitrary `GET` requests into the victim's local backend, which can expose sessions, diffs, workspace files, and configuration data far outside the intended shared session.
  - Attackers can also revoke all active shares by calling the unauthenticated delete route.
- Fix:
  - Require authenticated ownership checks for listing and deleting shares.
  - Make share URLs unguessable and non-enumerable; never return all active share IDs publicly.
  - Enforce `session_scope` on every share-backed browser request before forwarding `ApiRequest`, `PreviewRequest`, `FileBrowse`, or terminal-related messages.
  - Restrict bridged file browsing to the intended workspace root, not arbitrary filesystem paths.
- Mitigation:
  - Disable relay share functionality until access control and scope enforcement are fixed.
  - If shares must stay enabled temporarily, gate them behind authenticated dashboard routes only and rotate any active share IDs.
- False positive notes:
  - This finding does not depend on write access; read-only access is already enough to expose local project data and device metadata.

## High-Risk Weakness

### COND-SEC-003

- Severity: High
- Title: Relay browser JWTs become unsigned when `RELAY_JWT_SECRET` is unset
- Location:
  - `packages/web/src/lib/bridgeRelayAuth.ts:26`
  - `crates/conductor-relay/src/relay.rs:2413`
  - `crates/conductor-relay/src/relay.rs:2572`
- Evidence:
  - The dashboard emits `alg: "none"` JWTs when `RELAY_JWT_SECRET` is absent.
  - The relay then accepts those tokens by base64-decoding the payload without verifying a signature whenever no secret is configured.
- Impact:
  - Anyone who can obtain a relay browser endpoint and terminal ID can forge arbitrary identities for browser-terminal access in deployments missing `RELAY_JWT_SECRET`.
  - This materially worsens COND-SEC-001 because the attacker does not need any signing material to finish the relay-terminal flow.
- Fix:
  - Make `RELAY_JWT_SECRET` mandatory for any relay feature that consumes browser JWTs.
  - Reject unsigned tokens outright on both the dashboard and relay sides.
- Mitigation:
  - Treat relay deployments without `RELAY_JWT_SECRET` as insecure and non-production.

## Residual Notes

- I did not find a critical auth bypass in the Rust backend itself during this pass; it explicitly refuses non-loopback binding unless `CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND=true` is set.
- I did not review third-party dependencies, deployment infrastructure, or runtime reverse-proxy configs here, so this report is limited to vulnerabilities visible in repository code.
