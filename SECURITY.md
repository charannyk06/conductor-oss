# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest tagged release | ✅ Yes |
| Older releases | ❌ No |

Conductor OSS is under active development. Security patches are applied to the latest release only.

---

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

### Option 1 — GitHub Security Advisories (preferred)

Use [GitHub's private vulnerability reporting](https://github.com/charannyk06/conductor-oss/security/advisories/new) to submit a report directly to the maintainers. This keeps the report private while we work on a fix.

### Option 2 — Email

Send a report to: **anusrinivasan22@gmail.com**

Subject line: `[SECURITY] conductor-oss — <brief description>`

Include:
- A description of the vulnerability and potential impact
- Steps to reproduce or a proof-of-concept (if safe to share)
- Any suggested fixes (optional but appreciated)

---

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgment | Within 24 hours |
| Initial assessment | Within 72 hours |
| Fix or mitigation | Within 14 days for critical, 30 days for others |
| Public disclosure | After fix is released or 90 days (whichever comes first) |

We follow responsible disclosure: we'll coordinate with you before publishing any advisory.

---

## Security Architecture

Conductor is designed to be **local-first and low-attack-surface**:

### SQLite-backed local state
- Session and runtime metadata are stored locally in `.conductor/conductor.db`
- Board and workspace intent still live in Markdown and YAML (`CONDUCTOR.md`, `conductor.yaml`)
- Conductor does not require an external database service

### Local-first by default
- Core orchestration runs on your machine
- No hosted control plane is required for normal local use
- Networked features such as GitHub integration, webhooks, external identity providers, or bridge/relay flows are opt-in

### Worktree separation and agent trust
- Git-backed sessions normally use a separate `git worktree` so concurrent branches do not overwrite each other's checked-out files
- A worktree is a source-control concurrency boundary, not an operating-system security sandbox: local agents still run as your user and may access anything that account can access
- Session IDs namespace Conductor's runtime records, but they do not replace filesystem permissions, containers, VMs, or an agent vendor's own sandbox
- New repositories use normal agent approval behavior by default; automatic permission mode is opt-in and intended only for trusted workspaces

### Secrets and local tokens
- Agent credentials are expected to stay with the upstream CLIs or environment variables; Conductor does not proxy agent billing or auth
- Workspace state in `.conductor/` may include runtime metadata, detached terminal state, and optional bridge token/state files when bridge flows are enabled
- A self-hosted relay's persistent state file contains raw, long-lived device and refresh credentials. Keep the volume and its backups private and encrypted, preserve `0600` file permissions, and rotate paired-device credentials after any exposure
- The example config uses placeholder values only

### Optional Authentication (Dashboard)
- The default launcher keeps the dashboard on loopback (`127.0.0.1:4747`)
- Verified public access is expected to sit behind an identity layer such as Cloudflare Access
- Optional Clerk-backed sign-in flows also exist in the web app
- Without an auth layer, the dashboard is intended for local use only and should not be exposed to the internet

### Webhook Signature Verification
- GitHub webhook events are verified using **HMAC-SHA256** signatures
- Set a webhook secret in your GitHub repository settings and in `conductor.yaml`
- Requests with invalid or missing signatures are rejected with `401`

### MCP Server (stdio only)
- The optional MCP server runs over **stdio** — it has no network listener
- There is no port binding and no HTTP surface for the MCP server

### Known CVEs

The following CVEs are currently ignored in the dependency audit (`.cargo/audit.toml` and `.github/workflows/security.yml`):

| CVE | Dependency | Reason | Action |
|-----|-----------|--------|--------|
| RUSTSEC-2023-0071 | rsa (RSA crypto) | No fixed version available; low risk for Conductor's use case | Monitoring for upstream fix |
| RUSTSEC-2024-0384 | instant | Low severity, active upstream development, acceptable transitive risk | Monitoring for upstream fix |

**Dependency Audit CI** runs on every PR and weekly. As fixes become available, dependencies are automatically upgraded. See `.github/workflows/security.yml` for current audit configuration.

---

## Security Best Practices for Users

1. **Pin agents to specific models** — avoid `latest` model aliases in production configurations, as new model versions may behave differently

2. **Keep the normal agent permission default** — enable Conductor's automatic permission mode only for trusted workspaces on machines without sensitive credentials. The default preserves upstream approval behavior where the agent provides it; it is not an operating-system sandbox.

3. **Review PRs before merging** — AI agents make mistakes. Always review diffs before approving or merging agent-created PRs

4. **Set a webhook secret** — if using GitHub webhook integration, always configure a secret:
   ```yaml
   # conductor.yaml
   webhook:
     secret: "${WEBHOOK_SECRET}"  # use an env var, never hardcode
   ```

5. **Do not publish the dashboard unauthenticated** — if you expose it beyond localhost, use Cloudflare Access, Clerk, or another verified auth boundary with TLS

6. **Keep `~/.conductor/` private** — it may contain repository paths, session metadata, and optional bridge tokens or runtime state. Treat it like any other local secrets-adjacent config directory

7. **Rotate credentials after any suspected compromise** — revoke and re-issue GitHub tokens, API keys, and webhook secrets immediately if you suspect unauthorized access

---

## Responsible Disclosure

We believe in responsible disclosure and will:
- Acknowledge your report within 24 hours
- Provide regular updates on our progress
- Credit you in the security advisory (unless you prefer to remain anonymous)
- Not take legal action against researchers acting in good faith

Thank you for helping keep Conductor OSS and its users safe.
