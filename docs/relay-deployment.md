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
3. Optionally calls a relay rollout webhook
4. Optionally probes the relay health endpoint after rollout

## Required repository secrets

To make relay deployment fully automatic, configure these repository secrets:

- `RELAY_DEPLOY_WEBHOOK_URL`
  - HTTPS endpoint that tells your relay host to pull and restart the latest image
- `RELAY_DEPLOY_WEBHOOK_TOKEN`
  - Optional bearer token sent as `Authorization: Bearer ...`
- `RELAY_HEALTHCHECK_URL`
  - Optional health endpoint, for example `https://relay.conductross.com/health`

## Published image

The workflow publishes the relay image to:

- `ghcr.io/<owner>/conductor-relay:sha-<commit>`
- `ghcr.io/<owner>/conductor-relay:latest`

## Suggested rollout contract

The deploy webhook should:

1. Pull the requested image from GHCR
2. Stop the running relay container
3. Start the new relay container with the same env vars and ports
4. Return a non-2xx status if rollout fails

Expected JSON payload:

```json
{
  "image": "ghcr.io/<owner>/conductor-relay:sha-<commit>",
  "sha_tag": "ghcr.io/<owner>/conductor-relay:sha-<commit>",
  "ref": "<git sha>"
}
```

## Manual fallback

If the webhook is not configured yet, the workflow still publishes the image. You can then redeploy the relay host manually by pulling the latest GHCR image and restarting the container.

Critical detail, if your reverse proxy also runs in Docker, the relay container must join the same Docker network as that proxy and keep the `conductor-relay` network alias. If Caddy or Nginx proxies to `conductor-relay:8080` but cannot resolve that hostname inside its own container, the public relay host will return 502 even though the relay container itself is healthy.

Example rollout on a host where Caddy runs inside the `clawcloud_default` network:

```bash
docker pull ghcr.io/<owner>/conductor-relay:latest

RELAY_TAG=ghcr.io/<owner>/conductor-relay:latest \
RELAY_NAME=conductor-relay \
RELAY_NETWORK=clawcloud_default \
RELAY_NETWORK_ALIAS=conductor-relay \
RELAY_PORT= \
RELAY_DETACH=1 \
./scripts/start-relay.sh
```

Then verify both the private upstream path and the public health endpoint:

```bash
docker exec <caddy-container> curl -fsS http://conductor-relay:8080/health
curl -fsS https://relay.conductross.com/health
```
