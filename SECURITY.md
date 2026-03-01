# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

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

### No Database
- All session state is stored as flat `key=value` files in `~/.conductor/`
- No SQL, no ORMs — no SQL injection surface exists

### No Cloud Dependency
- Conductor runs entirely on your local machine
- No data leaves your machine unless you configure GitHub SCM integration
- No telemetry, no analytics, no external pings

### Agent Isolation via Git Worktrees
- Each agent session runs in a separate `git worktree`, isolated from your main branch
- A compromised or runaway agent cannot directly corrupt your working tree
- Sessions are namespaced by `session-id` — no cross-session bleed

### No Secrets in State Files
- `~/.conductor/` stores only session IDs, status flags, PR numbers, and timestamps
- API keys are read from environment variables — never persisted to disk by Conductor
- The example config (`conductor.example.yaml`) uses placeholder values only

### Optional Authentication (Dashboard)
- The web dashboard is **open by default** — it binds to `localhost:4747`
- Clerk authentication can be enabled by setting keys in `packages/web/.env.local`
- Without Clerk, the dashboard is intended for local use only; it should **not** be exposed to the internet without authentication

### Webhook Signature Verification
- GitHub webhook events are verified using **HMAC-SHA256** signatures
- Set a webhook secret in your GitHub repository settings and in `conductor.yaml`
- Requests with invalid or missing signatures are rejected with `401`

### MCP Server (stdio only)
- The optional MCP server runs over **stdio** — it has no network listener
- There is no port binding and no HTTP surface for the MCP server

---

## Security Best Practices for Users

1. **Pin agents to specific models** — avoid `latest` model aliases in production configurations, as new model versions may behave differently

2. **Use `--dangerously-skip-permissions` only in trusted environments** — this flag disables Claude Code's safety prompts. Never run it on a machine with access to production credentials

3. **Review PRs before merging** — AI agents make mistakes. Always review diffs before approving or merging agent-created PRs

4. **Set a webhook secret** — if using GitHub webhook integration, always configure a secret:
   ```yaml
   # conductor.yaml
   webhook:
     secret: "${WEBHOOK_SECRET}"  # use an env var, never hardcode
   ```

5. **Run the dashboard behind a reverse proxy in production** — if you expose the dashboard beyond localhost, put it behind nginx/Caddy with TLS and authentication

6. **Keep `~/.conductor/` private** — session metadata may contain repository paths and PR numbers. Treat it like any other local config directory

7. **Rotate credentials after any suspected compromise** — revoke and re-issue GitHub tokens, API keys, and webhook secrets immediately if you suspect unauthorized access

---

## Responsible Disclosure

We believe in responsible disclosure and will:
- Acknowledge your report within 24 hours
- Provide regular updates on our progress
- Credit you in the security advisory (unless you prefer to remain anonymous)
- Not take legal action against researchers acting in good faith

Thank you for helping keep Conductor OSS and its users safe.
