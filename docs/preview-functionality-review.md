# Preview functionality review

Date: 2026-06-23

## Scope

Reviewed the production preview path end to end:

1. `SessionPreview` UI controls and screenshot/DOM loading.
2. Next.js preview API routes under `packages/web/src/app/api/sessions/[id]/preview`.
3. Candidate discovery in `packages/web/src/lib/previewSession.ts`.
4. Remote preview worker client in `packages/web/src/lib/previewWorkerClient.ts`.
5. Preview worker browser/session implementation under `preview-worker/src`.
6. Relay bridge forwarding in `crates/conductor-relay/src/relay.rs`.
7. Paired-device bridge client code in `bridge-cmd/relay/client.go` and Rust CLI bridge fallback in `crates/conductor-cli/src/bridge.rs`.
8. Current production wiring for Vercel, relay, and preview-worker health.

## Production findings

- `app.conductross.com` production deployment is ready and recent.
- Vercel production has `CONDUCTOR_PREVIEW_WORKER_URL`, `CONDUCTOR_PREVIEW_WORKER_KEY`, `CONDUCTOR_BRIDGE_RELAY_URL`, `NEXT_PUBLIC_CONDUCTOR_BRIDGE_RELAY_URL`, and `RELAY_JWT_SECRET` configured.
- Relay public health is healthy and reported one active bridge channel during review.
- Preview worker public health is healthy at the Contabo-backed worker endpoint and reported zero active sessions at the time of review.
- Preview worker container has bridge-preview support present: `clientSessionId`, `bridgePreview`, `requestBridgePreview`, and tunnel readiness code are in the live container.

## Main broken path found

Manual preview URLs on hosted bridge sessions were not preserved across every preview endpoint.

The main status and connect route accepted `previewUrlHint`, so a user could type `http://localhost:3000` and press Connect. But screenshot and DOM inspector requests did not forward that hint. For bridge sessions without a saved project dev-server URL or session metadata, those follow-up routes reconstructed preview context without the manual URL, then called the preview manager with no bridge preview config.

That means a successful manual connection could immediately lose the bridge config when the screenshot image or DOM inspector loaded. From the product surface this looks like preview never really starts in production.

Fixed in this branch by:

- Passing `previewUrlHint` from `SessionPreview` to screenshot and DOM requests.
- Teaching `/preview/screenshot` and `/preview/dom` routes to read `previewUrlHint` and preserve the bridge preview config.
- Adding a regression test that proves bridge DOM and screenshot routes use the manual URL hint and do not fall through to repository lookup.

## Secondary broken path found

The Rust `conductor-cli` bridge preview proxy blocked `localhost` and `127.0.0.1` as SSRF targets. That is backwards for bridge preview: the paired device must be able to proxy its own loopback dev server.

The hosted installer currently uses the Go `conductor-bridge` client, whose preview URL handling already allows loopback hosts and rejects non-loopback hosts. Still, the Rust CLI bridge fallback was wrong and could break anyone using `co bridge` directly.

Fixed in this branch by:

- Replacing the Rust preview host check with a loopback-only allowlist.
- Allowing `localhost`, `127.0.0.1`, `[::1]`, and `0.0.0.0` for dev servers.
- Blocking public, LAN, metadata, and unverified hosts on the bridge preview path.
- Adding Rust regression tests for loopback and non-loopback preview hosts.

## Verified behavior after fixes

- Hosted bridge UI keeps the manual preview URL attached to status, screenshot, and DOM inspector calls.
- Bridge preview stays loopback-only on the paired device side.
- Direct remote preview URLs still use direct worker navigation, not bridge relay proxying.
- Production services needed by preview are online and configured.

## Follow-up recommendation

The next product hardening pass should add a visible preview health panel in the UI that shows which layer is failing: candidate discovery, worker session creation, bridge relay forwarding, paired-device HTTP fetch, screenshot capture, or DOM inspection. Right now those failures blur into a generic disconnected preview state, which makes production issues feel like the feature simply does not exist.
