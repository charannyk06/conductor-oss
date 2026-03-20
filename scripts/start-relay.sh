#!/bin/bash
set -e

cd "$(dirname "$0")/.."

RELAY_TAG="conductor-relay:latest"
RELAY_PORT="${RELAY_PORT:-8080}"

echo "Building Conductor Relay..."
if docker build -f Dockerfile.relay -t "$RELAY_TAG" . > /dev/null 2>&1; then
    echo "Relay image up to date."
else
    echo "Docker build failed. Make sure Docker is running."
    exit 1
fi

echo "Starting Conductor Relay on port $RELAY_PORT..."
docker run --rm \
    -p "${RELAY_PORT}:8080" \
    -e RUST_LOG="${RUST_LOG:-info}" \
    --name conductor-relay \
    "$RELAY_TAG"
