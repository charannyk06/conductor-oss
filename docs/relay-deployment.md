# Relay Deployment

Conductor web and Conductor relay are separate production surfaces.

- `app.conductross.com` is the hosted web dashboard.
- `relay.conductross.com` is the websocket relay used by paired-device bridge terminals.

A web deploy alone is not enough to roll out relay fixes. If the relay service stays on an older binary, hosted ttyd terminals can keep failing even after the dashboard has the latest code.

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
