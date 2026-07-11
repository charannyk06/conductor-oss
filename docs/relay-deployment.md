# Relay Deployment

Conductor web and Conductor relay are separate production surfaces.

- `app.conductross.com` is the hosted web dashboard.
- `relay.conductross.com` is the websocket relay used by paired-device bridge terminals.

A web deploy alone is not enough to roll out relay fixes. If the relay service stays on an older binary, hosted terminal sessions can keep failing even after the dashboard has the latest code.

## New automation

This repo now includes `.github/workflows/deploy-relay.yml`.

On pushes to `main` that touch relay-related files, the workflow:

1. Builds `crates/conductor-relay/Dockerfile`
2. Publishes a multi-arch image to GHCR
3. Sends the immutable image digest to a restricted SSH deployment command
4. Requires the public relay health endpoint to report `ok: true` and `ready: true`

## Required protected-environment secrets

Create the `relay-production` GitHub environment, restrict its deployment branch to `main`, and configure these environment secrets (not repository-wide secrets):

- `RELAY_DEPLOY_SSH_HOST`
  - Relay host name or address
- `RELAY_DEPLOY_SSH_USER`
  - Dedicated locked-down deployment user
- `RELAY_DEPLOY_SSH_KEY`
  - Private Ed25519 key whose public key is restricted to the relay deployment command
- `RELAY_DEPLOY_SSH_HOST_KEY`
  - Pinned `known_hosts` entry for the relay host; do not populate this with `ssh-keyscan` during CI
- `RELAY_HEALTHCHECK_URL`
  - Required health endpoint, for example `https://relay.conductross.com/health`

The relay host must also provide a `RELAY_JWT_SECRET` containing at least 32 bytes, an exact-origin `RELAY_ALLOWED_ORIGINS` list, and persist `/var/lib/conductor-relay` across restarts. Generate a new signing secret with `openssl rand -hex 32` and configure the same value on the relay and dashboard without committing it. The origin list defaults to `https://app.conductross.com`; self-hosted dashboards must add their own HTTP(S) origin explicitly. A missing or weak authentication secret, invalid origin policy, or unavailable state path makes startup fail or `/health` return `503` and `ready: false`.

When a reverse proxy supplies `X-Forwarded-For`, set `RELAY_TRUSTED_PROXIES` to only the IP address or CIDR of the actual proxy hop. The relay ignores forwarding headers from every other peer. Leaving this value empty is secure, but all proxied device claims then share the proxy's rate-limit bucket. The production forced command derives the current Caddy container IP from the shared Docker network on each rollout instead of trusting an entire public or host network.

Treat the relay state volume as secret material. Its state file contains raw, long-lived device and refresh credentials in addition to pairing ownership. Restrict host and backup access, preserve the file's `0600` permissions, encrypt backups, and rotate paired-device credentials if the volume or a backup is exposed.

## Published image

The workflow publishes the relay image to:

- `ghcr.io/<owner>/conductor-relay:sha-<commit>`
- `ghcr.io/<owner>/conductor-relay:latest`

Rollouts use the digest-pinned form (`ghcr.io/<owner>/conductor-relay@sha256:<digest>`) so a mutable tag cannot change between publication and deployment.

## Required host command contract

The SSH public key must use an `authorized_keys` forced command plus forwarding restrictions. The forced command must accept only deployments and its non-mutating integrity probe:

```text
deploy ghcr.io/<owner>/conductor-relay@sha256:<64 lowercase hex> <40 lowercase hex commit>
verify-script <64 lowercase hex script SHA-256>
```

The host command should:

1. Reject every other command and image registry
2. Serialize rollouts with a host lock
3. Pull the requested digest-pinned image
4. Require the exact `/var/lib/conductor-relay/state.json` path on the named state volume, or migrate the single known legacy `/data/relay-state.json` layout
5. Take a mode-`0600`, memory-backed state snapshot while the old relay is stopped
6. Pass the JWT secret through the Docker client environment, never as a command argument
7. Replace the container with a read-only root filesystem, bounded resources and logs, dropped capabilities, and `no-new-privileges`
8. Wait for private and public health and confirm `buildSha` matches the requested commit
9. Restore both the prior container and its state snapshot on any failed readiness check

The key must not provide an interactive shell, PTY, agent forwarding, port forwarding, or arbitrary command execution. A typical key prefix is:

```text
restrict,command="/usr/local/sbin/conductor-relay-deploy" ssh-ed25519 ...
```

Install [`scripts/conductor-relay-deploy-host.sh`](../scripts/conductor-relay-deploy-host.sh) as the root-owned, non-writable `/usr/local/sbin/conductor-relay-deploy` forced command. Its deployment user needs access to Docker, `flock`, `jq`, GNU `timeout`, a writable memory-backed `/dev/shm`, and an owner-writable `/var/lock/conductor-relay-deploy.lock`; the account itself should have a locked password and no unrestricted authorized key. The temporary rollback snapshot is never printed, is removed after success or rollback, and is not a substitute for an encrypted off-host backup.

The workflow checks the installed command against the reviewed repository script before every rollout. A script change therefore requires an administrator to reinstall the root-owned host command before merging; a stale command fails closed instead of deploying with host drift.

The migration exception is deliberately narrow: only the same named volume mounted at `/data` with `RELAY_STATE_FILE=/data/relay-state.json` is accepted. The command stops the old relay, takes the memory-backed mode-`0600` snapshot, copies it to the canonical filename while retaining the legacy file for rollback, and deletes the legacy duplicate only after private, proxy, and public exact-build health all pass. Any other mount, filename, symlink, non-regular file, conflicting canonical file, or insecure state-file mode fails closed.

## Manual fallback

The deployment workflow intentionally fails if the restricted SSH identity or healthcheck URL is missing. This prevents a published-but-never-deployed relay image from appearing green. Maintainers can still perform a controlled manual rollout.

Critical detail, if your reverse proxy also runs in Docker, the relay container must join the same Docker network as that proxy and keep the `conductor-relay` network alias. If Caddy or Nginx proxies to `conductor-relay:8080` but cannot resolve that hostname inside its own container, the public relay host will return 502 even though the relay container itself is healthy.

Example rollout on a host where Caddy runs inside the `clawcloud_default` network:

```bash
export RELAY_IMAGE='ghcr.io/<owner>/conductor-relay@sha256:<digest>'
docker pull "$RELAY_IMAGE"
docker volume inspect conductor-relay-state >/dev/null

RELAY_TAG="$RELAY_IMAGE" \
RELAY_BUILD=0 \
RELAY_NAME=conductor-relay \
RELAY_NETWORK=clawcloud_default \
RELAY_NETWORK_ALIAS=conductor-relay \
RELAY_PORT= \
RELAY_DETACH=1 \
RELAY_JWT_SECRET="$RELAY_JWT_SECRET" \
RELAY_ALLOWED_ORIGINS=https://app.conductross.com \
RELAY_TRUSTED_PROXIES='<exact proxy IP or private proxy CIDR>' \
RELAY_STATE_VOLUME=conductor-relay-state \
RELAY_HEALTHCHECK_URL=https://relay.conductross.com/health \
./scripts/start-relay.sh
```

`start-relay.sh` refuses to create a missing state volume implicitly. For a first installation only, create `conductor-relay-state` explicitly or set `RELAY_CREATE_STATE_VOLUME=1`. When replacing an existing container, the script keeps the old container stopped under a rollback name, snapshots the exact state file with mode `0600`, starts the candidate with resource and log limits, and accepts it only after `/health` reports ready. Set the HTTPS-only `RELAY_HEALTHCHECK_URL` in production so the public route must report the same build before acceptance. A failed detached rollout restores both the old container and its state. A foreground replacement is temporary: when it exits, the prior container and snapshot are restored.

Then verify both the private upstream path and the public health endpoint:

```bash
docker exec <caddy-container> curl -fsS http://conductor-relay:8080/health
curl -fsS https://relay.conductross.com/health \
  | jq -e --arg expected '<git-sha>' '.ok == true and .ready == true and .buildSha == $expected'
```

Do not delete or replace the named state volume during normal upgrades. It contains pairing ownership and raw device credentials; losing it invalidates existing pairings, while exposing it requires credential rotation. The rollout scripts require its mount at `/var/lib/conductor-relay` and reject alternate or traversal-based state paths rather than silently moving credentials outside durable storage.
