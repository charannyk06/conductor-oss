# Preview Worker Deployment

The hosted preview worker is a separate production service from the Vercel dashboard. Changes under `preview-worker/` are published and rolled out by `.github/workflows/deploy-preview-worker.yml`; a dashboard deployment alone does not update Chromium or the preview network policy.

## Automated rollout

On relevant pushes to `main`, the workflow builds a multi-architecture image, publishes it to GHCR with provenance and an SBOM, deploys its immutable digest through a restricted SSH command, and requires the public TLS health endpoint to report the exact source commit in `buildSha`.

Create the `preview-production` GitHub environment, restrict its deployment branch to `main`, and configure these environment secrets (not repository-wide secrets):

- `PREVIEW_DEPLOY_SSH_HOST`: preview host name or address
- `PREVIEW_DEPLOY_SSH_USER`: dedicated locked-down deployment user
- `PREVIEW_DEPLOY_SSH_KEY`: private Ed25519 deployment key
- `PREVIEW_DEPLOY_SSH_HOST_KEY`: pinned `known_hosts` entry collected out of band
- `PREVIEW_WORKER_HEALTHCHECK_URL`: public TLS endpoint, such as `https://preview-worker.example.com/health`

The worker host must already have a `WORKER_API_KEY` of at least 32 bytes. Keep `CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX=false`. Chromium's sandbox setup requires `SYS_ADMIN` and `SYS_CHROOT` in this container; the forced command drops every capability and then restores only those two. The command launches a real browser session before accepting the rollout, so a sandbox or capability regression triggers rollback.

## Host command contract

Install [`scripts/conductor-preview-deploy-host.sh`](../scripts/conductor-preview-deploy-host.sh) as the root-owned, non-writable `/usr/local/sbin/conductor-preview-deploy` forced command. Its SSH key must accept only:

```text
deploy ghcr.io/charannyk06/conductor-preview-worker@sha256:<64 lowercase hex> <40 lowercase hex commit>
verify-script <64 lowercase hex script SHA-256>
```

Use an authorized-key prefix such as:

```text
restrict,command="/usr/local/sbin/conductor-preview-deploy" ssh-ed25519 ...
```

The deployment user needs Docker access, GNU `timeout`, `jq`, and an owner-writable `/var/lock/conductor-preview-deploy.lock`, but no unrestricted SSH key. The workflow uses the non-mutating integrity probe to require that the installed command matches the reviewed repository script, so an administrator must reinstall the root-owned command whenever it changes.

The forced command preserves the existing API key and session limits without putting the key in Docker command arguments, applies `no-new-privileges`, drops all Linux capabilities before restoring only `SYS_ADMIN` and `SYS_CHROOT` for Chromium's sandbox, uses a read-only root filesystem plus a bounded temporary filesystem, enforces process/memory/CPU and Docker-log limits, joins the private Caddy network without publishing port 3099 on the host, verifies the exact build, creates and deletes a sandboxed session, checks both Caddy and the public TLS endpoint, and restores the previous container on failure. Destructive Docker operations have host-side deadlines so a stuck daemon call cannot leave the rollout lock held indefinitely.

## Network boundary

Caddy should proxy the worker through its private Docker alias:

```text
reverse_proxy conductor-preview-worker:3099
```

Do not publish `3099:3099` in production. The public TLS endpoint exposes health and authenticated APIs through Caddy; worker requests require the bearer API key. The dashboard must use the same endpoint through `CONDUCTOR_PREVIEW_WORKER_URL` and the same secret through `CONDUCTOR_PREVIEW_WORKER_KEY`.

After a rollout, verify both build identity and the absence of a public host listener:

```bash
curl -fsS "$PREVIEW_WORKER_HEALTHCHECK_URL" \
  | jq -e --arg expected '<git-sha>' '.ok == true and .buildSha == $expected'
ss -ltn | grep ':3099 ' && { echo 'unexpected public preview listener' >&2; exit 1; } || true
```

The service intentionally blocks all browser `ws:`, `wss:`, `file:`, `ftp:`, and `gopher:` traffic. Public WebSockets remain unavailable until they can use a DNS-pinned transport equivalent to the worker's HTTP interception path.
