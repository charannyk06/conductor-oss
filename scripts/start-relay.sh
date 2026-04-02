#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

RELAY_TAG="${RELAY_TAG:-conductor-relay:latest}"
RELAY_NAME="${RELAY_NAME:-conductor-relay}"
RELAY_PORT="${RELAY_PORT:-8080}"
RELAY_DOCKERFILE="${RELAY_DOCKERFILE:-crates/conductor-relay/Dockerfile}"
RELAY_NETWORK="${RELAY_NETWORK:-}"
RELAY_NETWORK_ALIAS="${RELAY_NETWORK_ALIAS:-conductor-relay}"
RELAY_DETACH="${RELAY_DETACH:-0}"
RELAY_REMOVE_EXISTING="${RELAY_REMOVE_EXISTING:-1}"
RELAY_RESTART_POLICY="${RELAY_RESTART_POLICY:-unless-stopped}"

echo "Building Conductor Relay..."
if docker build -f "$RELAY_DOCKERFILE" -t "$RELAY_TAG" . > /dev/null 2>&1; then
    echo "Relay image up to date."
else
    echo "Docker build failed. Make sure Docker is running."
    exit 1
fi

if [ "$RELAY_REMOVE_EXISTING" = "1" ]; then
    docker rm -f "$RELAY_NAME" > /dev/null 2>&1 || true
fi

run_args=(
    --name "$RELAY_NAME"
    -e RUST_LOG="${RUST_LOG:-info}"
)

if [ -n "$RELAY_PORT" ]; then
    run_args+=( -p "${RELAY_PORT}:8080" )
fi

if [ -n "$RELAY_NETWORK" ]; then
    run_args+=( --network "$RELAY_NETWORK" --network-alias "$RELAY_NETWORK_ALIAS" )
fi

if [ "$RELAY_DETACH" = "1" ]; then
    run_args+=( -d --restart "$RELAY_RESTART_POLICY" )
else
    run_args+=( --rm )
fi

if [ -n "$RELAY_NETWORK" ]; then
    echo "Starting Conductor Relay on network $RELAY_NETWORK as $RELAY_NETWORK_ALIAS..."
else
    if [ -n "$RELAY_PORT" ]; then
        echo "Starting Conductor Relay on port $RELAY_PORT..."
    else
        echo "Starting Conductor Relay without publishing a host port..."
    fi
fi

docker run "${run_args[@]}" "$RELAY_TAG"
