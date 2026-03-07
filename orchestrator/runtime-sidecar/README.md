# Conductor runtime sidecar

Rust HTTP sidecar that exposes the executor boundary used by the web app.

## Endpoints

- `GET /health`
- `GET /sessions/:id/feed`
- `POST /sessions/:id/send`

## Environment

- `CONDUCTOR_EXECUTOR_PORT`: port to bind, defaults to `4318`
- `CONDUCTOR_WEB_INTERNAL_BASE_URL`: internal web origin, defaults to `http://127.0.0.1:3000`
- `CONDUCTOR_EXECUTOR_REMOTE_TOKEN`: optional token required on sidecar public requests
- `CONDUCTOR_EXECUTOR_INTERNAL_TOKEN`: optional token injected by the sidecar when calling the web app's internal executor routes

## Purpose

This is a migration seam. The web UI talks to a stable executor contract, and the sidecar currently proxies to the existing local session-manager-backed implementation through private internal routes. The next step is to move feed/send execution logic from the internal web routes into Rust without changing the public frontend contract.
