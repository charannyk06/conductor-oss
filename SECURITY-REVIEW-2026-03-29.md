# Conductor OSS Security Review
Date: 2026-03-29
Reviewer: Automated code review
Scope: Full repo security review + Strix setup

## Summary

Conductor OSS has solid security architecture for a local-first tool. The Rust backend refuses remote binding by default, dashboard auth is well-designed with Clerk/Cloudflare/local fallbacks, and most API routes have explicit role-based guards.

The remaining risk is concentrated in two areas:
1. The preview/browser auto-connect path
2. The relay onboarding/claim edge

Neither of these are trivial auth bypasses. They are architectural risks from combining a powerful server-side browser with a potentially public deployment surface.

---

## What Is Good

### Backend bind protection
`crates/conductor-server/src/lib.rs` refuses non-loopback binding unless `CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND=true` is explicitly set. This is the single strongest protection in the repo.

### Auth model
`packages/web/src/lib/auth.ts`:
- local unauth only for loopback
- non-loopback requires Clerk or Cloudflare Access
- action requests check origin/referrer/fetch-site
- per-route Viewer/Operator/Admin role enforcement

### Cloudflare Access verification
`packages/web/src/lib/edgeAuth.ts` verifies JWT tokens via JWKS, not just trusting headers. Legacy generic trusted-header mode is explicitly rejected.

### Preview browser protections
`packages/web/src/lib/devPreviewBrowser.ts`:
- blocks navigation to private IPs unless `CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS=true`
- isPrivateNetworkHostname check covers RFC1918 ranges
- per-session browser contexts (mitigates TM-003 cross-session leakage)

### Backend middleware
`crates/conductor-server/src/routes/middleware.rs`:
- require_auth_when_remote runs on all routes
- GET -> Viewer, non-GET -> Operator by default
- only /api/health and /api/github/webhook are intentionally open
- global rate limiting (2000 req/min)

### TTYD loopback binding
Terminal processes bind to 127.0.0.1 with random ports. Not exposed remotely by default.

---

## Issues Found and Status

### ISSUE 1: Dispatcher routes lack explicit per-route auth guards
Severity: Medium
Status: Mitigated by global middleware

The dispatcher router (`crates/conductor-server/src/routes/dispatcher.rs`) is merged into the main router in `lib.rs`. The global `require_auth_when_remote` middleware applies to all routes, including dispatcher routes. So dispatcher routes are NOT unprotected.

However, individual dispatcher routes do not have explicit `guardApiAccess` calls like the dashboard API routes do. This means:
- if global middleware config is broken, dispatcher routes have no second layer
- dispatcher routes always require Operator for non-GET operations (correct by default)
- but there is no per-route depth for advanced role checks

Recommendation: When you next refactor the dispatcher router, pass state to the router function and add explicit per-route guards matching the pattern in `projects.rs`.

### ISSUE 2: Preview auto-connect in hosted mode
Severity: High
Status: Partially mitigated

The preview system auto-connects to candidate URLs without explicit operator confirmation. The codebase has protection:
- `devPreviewBrowser.ts` blocks private-network SSRF by default
- `SessionPreview.tsx` selects the best candidate using `selectPreviewAutoConnectCandidate`
- POST preview commands require Operator role

But in a hosted deployment, an attacker who controls session metadata (via a malicious repo or compromised agent output) could influence the preview to auto-connect to an external URL. This is the TM-002 risk from the existing threat model.

Recommendation: Add a confirmation step before auto-connecting to non-loopback URLs in hosted (non-loopback) dashboard mode. The existing `allowSafeDirectNavigationTarget` protection is good but not sufficient when the attack vector is through session metadata rather than direct navigation.

### ISSUE 3: Preview browser state sharing (mitigated but documented)
Severity: Medium
Status: Mitigated

The threat model identifies TM-003 (cross-session browser state leakage). The code now uses `browser.createBrowserContext()` per session, which provides isolation. However, all contexts share the same browser process, so side-channel concerns remain.

Recommendation: Document this as accepted risk for now. Split into separate browser processes if multi-tenant becomes real.

### ISSUE 4: Terminal token in URL query parameters
Severity: Medium
Status: Documented in existing threat model

Terminal tokens are transported in WebSocket URL query parameters (`packages/web/src/app/api/sessions/[id]/terminal/ttyd/ws/route.ts`). This means tokens appear in browser history, proxy logs, and server logs.

Recommendation: Move to a one-time token exchange model where the browser exchanges the token for a header-based auth before opening the WebSocket. This is a known item from the existing threat model (TM-004).

### ISSUE 5: Relay claim endpoint lacks rate limiting
Severity: Medium
Status: Documented in existing threat model

The relay claim endpoint (`POST /api/devices/claims`) is unauthenticated and has no per-IP rate limiting. A sustained attack could fill the 1024 pending claim queue.

Recommendation: Add per-IP rate limiting, queue depth monitoring, and optional proof-of-work or authenticated claim creation.

---

## Strix Integration

### Files Added
- `strix-instructions.md` - scan context and scope for Strix agents
- `.github/workflows/strix-scan.yml` - CI workflow for PR scans and manual deep scans
- `docs/STRIX-SETUP.md` - local and CI Strix run instructions

### How To Run Locally
```bash
# Install
curl -sSL https://strix.ai/install | bash

# Source scan (no running app needed)
export STRIX_LLM="openai/gpt-5.4"
export LLM_API_KEY="sk-..."
strix -n -t ./ --scan-mode quick --instruction-file strix-instructions.md

# Full scan against a live dashboard
strix -n -t http://localhost:4747 -t ./ --scan-mode standard --instruction-file strix-instructions.md
```

### What Strix Will Test
- API route auth bypass attempts
- SSRF via preview flows
- XSS/CSRF in dashboard
- Terminal session hijacking
- Filesystem traversal
- Relay claim abuse
- Input validation on all mutation endpoints

### What Strix Will NOT Test
- Rust memory safety (use cargo clippy + Miri)
- Kanban write-back correctness (use replay tests)
- SSE stream stability (use custom harness)
- Agent execution safety (not a Strix concern)

---

## Remaining Manual Items

These cannot be auto-tested by Strix and need manual review:

1. Preview auto-connect confirmation for hosted mode
2. Per-route auth guards on dispatcher routes (refactor needed)
3. Terminal token one-time exchange model
4. Relay claim rate limiting
5. Security headers on all preview/screenshot responses
6. Ensure CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND is NEVER set on production
7. Ensure Cloudflare Access or Clerk is always configured on hosted deployments
8. Audit all env var documentation to make dangerous flags explicit

---

## Deployment Checklist (Quick Reference)

- [ ] Dashboard behind Cloudflare Access or Clerk
- [ ] `CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND` NOT set
- [ ] `CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS` NOT set
- [ ] `CONDUCTOR_CLOUDFLARE_ACCESS_TEAM_DOMAIN` set
- [ ] `CONDUCTOR_CLOUDFLARE_ACCESS_AUDIENCE` set
- [ ] GitHub webhook secret configured
- [ ] Relay behind firewall (if public, has rate limiting)
- [ ] Strix scan passing on PRs
