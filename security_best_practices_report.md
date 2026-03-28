# Security Best Practices Report

Date: 2026-03-27

## Executive Summary

I reviewed the highest-risk security surfaces in Conductor OSS for this pass: the Rust backend auth boundary, the Next.js dashboard proxy/auth bridge, the server-side preview browser, and baseline dashboard response headers.

Three concrete findings were fixed during this pass. After those fixes, I did not identify any remaining open critical or high-severity issues in the reviewed paths. Rust verification is clean: `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` both pass.

## High Severity

### SEC-001 - Fixed - Forged dashboard proxy headers could bypass backend auth on remotely exposed Rust deployments

Impact: An attacker who could reach a remotely bound Rust backend could have supplied `x-conductor-*` proxy auth headers directly and been treated as an authenticated dashboard caller.

- Location:
  - `crates/conductor-server/src/lib.rs:137`
  - `crates/conductor-server/src/routes/config.rs:369`
  - `packages/web/src/lib/guardedRustProxy.ts:17`
  - `packages/web/src/app/api/events/route.ts:44`
- Evidence:
  - The backend trusts forwarded proxy identity through `proxy_request_authorized(...)` and `resolve_proxy_access_identity(...)` in `crates/conductor-server/src/routes/config.rs`.
  - The dashboard proxy constructs those headers in `packages/web/src/lib/guardedRustProxy.ts`.
  - The backend startup path now explicitly blocks remote authenticated deployments unless `CONDUCTOR_PROXY_AUTH_SECRET` is configured in `crates/conductor-server/src/lib.rs:137`.
- Fix:
  - Added a shared `CONDUCTOR_PROXY_AUTH_SECRET` check for forwarded dashboard auth headers.
  - Updated the Next.js proxy path, including the SSE route, to forward the shared secret.
  - Refused startup when the Rust backend is intentionally exposed off-host with auth enabled but without a proxy-auth secret.
- Mitigation:
  - Keep the backend loopback-only unless there is a real deployment reason to expose it.
  - When exposing it off-host, set the same `CONDUCTOR_PROXY_AUTH_SECRET` in both the dashboard and backend processes.
- False positive notes:
  - This issue matters only when the Rust backend is reachable beyond loopback. Purely local deployments were already relying on the implicit same-host boundary.

## Medium Severity

### SEC-002 - Fixed - The server-side preview browser could be used to reach private-network targets outside the intended local preview boundary

Impact: A malicious preview URL or manually entered target could have turned the server-side browser into an SSRF path toward private or link-local network services.

- Location:
  - `packages/web/src/lib/devPreviewBrowser.ts:163`
  - `packages/web/src/lib/devPreviewBrowser.ts:212`
  - `packages/web/src/lib/devPreviewBrowser.ts:865`
- Evidence:
  - Direct preview navigation is handled in `connect(...)`.
  - The new `assertSafeDirectNavigationTarget(...)` guard rejects private IP literals and hostnames that resolve to private addresses unless `CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS=true` is explicitly set.
- Fix:
  - Added private-network hostname and DNS-resolution checks before direct preview navigation.
  - Preserved loopback/local dev preview support.
  - Added an explicit override env var for intentionally unsafe/internal preview targets.
- Mitigation:
  - Prefer loopback dev URLs for local preview flows.
  - Treat `CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS` as a temporary, tightly-scoped override.
- False positive notes:
  - Public-origin preview browsing is still allowed by design; this fix specifically blocks private-network pivoting rather than all remote browsing.

### SEC-003 - Fixed - Dashboard responses lacked a CSP baseline

Impact: Without a baseline CSP, the dashboard had less browser-enforced protection against framing abuse and unsafe object/base URI behavior.

- Location:
  - `packages/web/next.config.ts:6`
  - `packages/web/next.config.ts:19`
  - `packages/web/next.config.ts:28`
- Evidence:
  - `packages/web/next.config.ts` now adds a baseline `Content-Security-Policy` header and a terminal-specific CSP variant for the embedded ttyd surface.
- Fix:
  - Added a minimal non-breaking CSP baseline: `base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`.
  - Added a ttyd-specific variant with `frame-ancestors 'self'`.
- Mitigation:
  - If stricter CSP is desired later, expand this to nonce/hash-based script controls once the dashboard’s runtime script requirements are catalogued.
- False positive notes:
  - This was a defense-in-depth hardening gap rather than evidence of an active exploit path.

## Residual Notes

- No open critical or high-severity findings were identified in the audited paths after these fixes.
- Remote authenticated deployments now require `CONDUCTOR_PROXY_AUTH_SECRET`; this is an operational requirement, not an optional hardening step.
- TypeScript runtime validation could not be executed from this shell because neither `bun` nor `node` is installed here. Rust verification completed successfully.
