## Strix Configuration for Conductor OSS

### Required Secrets (GitHub repo secrets)
```bash
STRIX_LLM=openai/gpt-5.4
LLM_API_KEY=sk-...
```

The CI workflow fails in preflight if either secret is missing or if a manual
`target_url` is not an `http://` or `https://` URL. It does not silently skip a
requested scan.

### Local Run (no Docker required for source scans)
```bash
# Install Strix (one-time)
curl -sSL https://strix.ai/install | bash

# Source-only scan (fastest, no running app needed)
strix -n -t ./ --scan-mode quick --instruction-file strix-instructions.md

# Full scan against a running dashboard
export STRIX_LLM="openai/gpt-5.4"
export LLM_API_KEY="sk-..."
strix -n \
  -t http://localhost:4747 \
  -t ./ \
  --scan-mode standard \
  --instruction-file strix-instructions.md

# Deep scan (longer, more thorough)
strix -n \
  -t http://localhost:4747 \
  -t ./ \
  --scan-mode deep \
  --instruction-file strix-instructions.md

# Authenticated scan (if your dashboard requires login)
export STRIX_LLM="openai/gpt-5.4"
export LLM_API_KEY="sk-..."
strix -n \
  -t https://your-dashboard.com \
  -t ./ \
  --instruction "Perform authenticated testing. Dashboard is behind Cloudflare Access." \
  --instruction-file strix-instructions.md \
  --scan-mode deep
```

### What Gets Scanned
- API route analysis (static)
- Auth flow analysis (static)
- Browser automation tests (if target URL is provided)
- Fuzzing of API endpoints (if target URL is provided)
- XSS/CSRF vector discovery
- SSRF path testing via preview flows
- Terminal session auth bypass attempts
- Filesystem traversal tests
