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
RELAY_STATE_VOLUME="${RELAY_STATE_VOLUME:-conductor-relay-state}"
RELAY_ALLOWED_ORIGINS="${RELAY_ALLOWED_ORIGINS-https://app.conductross.com}"
RELAY_TRUSTED_PROXIES="${RELAY_TRUSTED_PROXIES:-}"
RELAY_BUILD="${RELAY_BUILD:-}"
RELAY_CREATE_STATE_VOLUME="${RELAY_CREATE_STATE_VOLUME:-0}"
RELAY_PIDS_LIMIT="${RELAY_PIDS_LIMIT:-256}"
RELAY_MEMORY_LIMIT="${RELAY_MEMORY_LIMIT:-512m}"
RELAY_CPU_LIMIT="${RELAY_CPU_LIMIT:-1}"
RELAY_LOG_MAX_SIZE="${RELAY_LOG_MAX_SIZE:-10m}"
RELAY_LOG_MAX_FILES="${RELAY_LOG_MAX_FILES:-3}"
RELAY_HEALTHCHECK_URL="${RELAY_HEALTHCHECK_URL:-}"

rollback_name="${RELAY_NAME}-rollback"
state_mount_destination="/var/lib/conductor-relay"
state_file="${state_mount_destination}/state.json"
docker_command_timeout_seconds=45
state_backup_dir=""
state_backup_owner=""
state_backup_existed=0
state_backup_ready=0
current_image_id=""
previous_stopped=0
previous_renamed=0
candidate_started=0

run_docker() {
    if command -v timeout >/dev/null 2>&1; then
        timeout --foreground --kill-after=5s "${docker_command_timeout_seconds}s" docker "$@"
    else
        docker "$@"
    fi
}

run_docker_build() {
    if command -v timeout >/dev/null 2>&1; then
        timeout --foreground --kill-after=10s 900s docker "$@"
    else
        docker "$@"
    fi
}

cleanup_state_backup() {
    if [ -n "$state_backup_dir" ] && [ -d "$state_backup_dir" ]; then
        rm -rf -- "$state_backup_dir"
    fi
    state_backup_dir=""
    state_backup_owner=""
    state_backup_existed=0
    state_backup_ready=0
}

backup_relay_state() {
    backup_parent="${TMPDIR:-/tmp}"
    if [ -d /dev/shm ] && [ -w /dev/shm ]; then
        backup_parent=/dev/shm
    fi

    umask 077
    state_backup_dir=$(mktemp -d "${backup_parent%/}/conductor-relay-state.XXXXXX")
    if ! backup_result=$(run_docker run --rm \
        --network none \
        --read-only \
        --user 0:0 \
        --security-opt no-new-privileges:true \
        --cap-drop ALL \
        --mount "type=volume,src=${RELAY_STATE_VOLUME},dst=/state,readonly" \
        --mount "type=bind,src=${state_backup_dir},dst=/backup" \
        --entrypoint /bin/sh \
        "$current_image_id" \
        -ec '
          if [ -L /state/state.json ]; then
            exit 2
          fi
          if [ -e /state/state.json ] && [ ! -f /state/state.json ]; then
            exit 2
          fi
          if [ ! -f /state/state.json ]; then
            printf "missing"
            exit 0
          fi
          umask 077
          cp -- /state/state.json /backup/state.json
          chmod 600 /backup/state.json
          stat -c "%u:%g" /state/state.json
        '); then
        echo "Could not create a secure relay state rollback snapshot." >&2
        return 1
    fi

    if [ "$backup_result" = "missing" ]; then
        state_backup_existed=0
    elif [[ "$backup_result" =~ ^[0-9]+:[0-9]+$ ]] \
        && [ -s "$state_backup_dir/state.json" ]; then
        state_backup_existed=1
        state_backup_owner="$backup_result"
    else
        echo "Could not create a secure relay state rollback snapshot." >&2
        return 1
    fi
    state_backup_ready=1
}

restore_relay_state() {
    if [ "$state_backup_ready" -ne 1 ]; then
        return 0
    fi

    if [ "$state_backup_existed" -eq 1 ]; then
        run_docker run --rm \
            --network none \
            --read-only \
            --user 0:0 \
            --security-opt no-new-privileges:true \
            --cap-drop ALL \
            --mount "type=volume,src=${RELAY_STATE_VOLUME},dst=/state" \
            --mount "type=bind,src=${state_backup_dir},dst=/backup,readonly" \
            --entrypoint /bin/sh \
            "$current_image_id" \
            -ec '
              owner="$1"
              rm -f -- /state/state.*.tmp /state/.state.json.rollback
              cp -- /backup/state.json /state/.state.json.rollback
              chmod 600 /state/.state.json.rollback
              chown "$owner" /state/.state.json.rollback
              mv -f -- /state/.state.json.rollback /state/state.json
            ' sh "$state_backup_owner" >/dev/null
    else
        run_docker run --rm \
            --network none \
            --read-only \
            --user 0:0 \
            --security-opt no-new-privileges:true \
            --cap-drop ALL \
            --mount "type=volume,src=${RELAY_STATE_VOLUME},dst=/state" \
            --entrypoint /bin/sh \
            "$current_image_id" \
            -ec 'rm -f -- /state/state.json /state/state.*.tmp /state/.state.json.rollback' \
            >/dev/null
    fi
}

restore_previous_relay() {
    status=$?
    trap - EXIT INT TERM

    if run_docker container inspect "$rollback_name" >/dev/null 2>&1; then
        previous_renamed=1
    else
        previous_renamed=0
    fi

    if [ "$previous_renamed" -eq 1 ]; then
        echo "Relay start failed or stopped; restoring the previous container and state." >&2
        if run_docker container inspect "$RELAY_NAME" >/dev/null 2>&1; then
            if ! run_docker rm -f "$RELAY_NAME" >/dev/null; then
                cleanup_state_backup
                echo "CRITICAL: failed to stop the replacement relay before rollback." >&2
                exit 94
            fi
        fi
        if ! restore_relay_state; then
            cleanup_state_backup
            echo "CRITICAL: failed to restore the previous relay state." >&2
            exit 93
        fi
        if ! run_docker rename "$rollback_name" "$RELAY_NAME"; then
            cleanup_state_backup
            echo "CRITICAL: failed to restore the previous relay container name." >&2
            exit 90
        fi
        if ! run_docker start "$RELAY_NAME" >/dev/null; then
            cleanup_state_backup
            echo "CRITICAL: failed to restart the previous relay container." >&2
            exit 91
        fi
    elif [ "$candidate_started" -eq 1 ]; then
        if run_docker container inspect "$RELAY_NAME" >/dev/null 2>&1; then
            run_docker rm -f "$RELAY_NAME" >/dev/null || true
        fi
        if ! restore_relay_state; then
            cleanup_state_backup
            echo "CRITICAL: failed to restore relay state after rejecting the candidate." >&2
            exit 93
        fi
    elif [ "$previous_stopped" -eq 1 ]; then
        if ! run_docker start "$RELAY_NAME" >/dev/null; then
            cleanup_state_backup
            echo "CRITICAL: failed to restart the current relay container." >&2
            exit 91
        fi
    fi

    if [ "$previous_stopped" -eq 1 ]; then
        restored=0
        for _ in $(seq 1 15); do
            health_json=$(run_docker exec "$RELAY_NAME" \
                curl --connect-timeout 2 --max-time 5 -fsS \
                http://127.0.0.1:8080/health 2>/dev/null || true)
            if jq -e '.ok == true and .ready == true' \
                <<< "$health_json" >/dev/null 2>&1; then
                restored=1
                break
            fi
            sleep 2
        done
        if [ "$restored" -ne 1 ]; then
            cleanup_state_backup
            echo "CRITICAL: previous relay restarted but did not become ready." >&2
            exit 92
        fi
    fi

    cleanup_state_backup
    exit "$status"
}

if [ -z "${RELAY_JWT_SECRET:-}" ]; then
    echo "RELAY_JWT_SECRET is required. Refusing to start a relay that cannot authenticate dashboard requests." >&2
    exit 1
fi
relay_secret_bytes=$(LC_ALL=C printf '%s' "$RELAY_JWT_SECRET" | wc -c | tr -d ' ')
if [ "$relay_secret_bytes" -lt 32 ]; then
    echo "RELAY_JWT_SECRET must contain at least 32 bytes. Generate one with: openssl rand -hex 32" >&2
    exit 1
fi
export -n RELAY_JWT_SECRET

if [ -z "$RELAY_STATE_VOLUME" ]; then
    echo "RELAY_STATE_VOLUME is required. Refusing to start without durable pairing state." >&2
    exit 1
fi

for flag_name in RELAY_DETACH RELAY_REMOVE_EXISTING RELAY_CREATE_STATE_VOLUME; do
    flag_value="${!flag_name}"
    if [ "$flag_value" != "0" ] && [ "$flag_value" != "1" ]; then
        echo "$flag_name must be 0 or 1." >&2
        exit 1
    fi
done

if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required for safe relay replacement and readiness checks." >&2
    exit 1
fi
if [ -n "$RELAY_HEALTHCHECK_URL" ]; then
    if [[ ! "$RELAY_HEALTHCHECK_URL" =~ ^https:// ]]; then
        echo "RELAY_HEALTHCHECK_URL must use HTTPS." >&2
        exit 1
    fi
    if ! command -v curl >/dev/null 2>&1; then
        echo "curl is required when RELAY_HEALTHCHECK_URL is configured." >&2
        exit 1
    fi
fi

if [ -z "$RELAY_ALLOWED_ORIGINS" ]; then
    echo "RELAY_ALLOWED_ORIGINS is required and must contain exact HTTP(S) origins." >&2
    exit 1
fi

if [ -z "$RELAY_BUILD" ]; then
    case "$RELAY_TAG" in
        conductor-relay:latest) RELAY_BUILD=1 ;;
        *) RELAY_BUILD=0 ;;
    esac
fi

if [ "$RELAY_BUILD" = "1" ]; then
    echo "Building Conductor Relay..."
    build_sha="${CONDUCTOR_BUILD_SHA:-$(git rev-parse HEAD 2>/dev/null || printf 'local')}"
    if run_docker_build build \
        --build-arg "CONDUCTOR_BUILD_SHA=$build_sha" \
        -f "$RELAY_DOCKERFILE" \
        -t "$RELAY_TAG" \
        . > /dev/null 2>&1; then
        echo "Relay image up to date."
    else
        echo "Docker build failed. Make sure Docker is running." >&2
        exit 1
    fi
elif ! run_docker image inspect "$RELAY_TAG" >/dev/null 2>&1; then
    echo "Relay image $RELAY_TAG is not present locally. Pull it first or set RELAY_BUILD=1." >&2
    exit 1
fi

if ! run_docker volume inspect "$RELAY_STATE_VOLUME" >/dev/null 2>&1; then
    if [ "$RELAY_CREATE_STATE_VOLUME" = "1" ]; then
        run_docker volume create "$RELAY_STATE_VOLUME" >/dev/null
    else
        echo "Relay state volume $RELAY_STATE_VOLUME does not exist. Create it explicitly or set RELAY_CREATE_STATE_VOLUME=1." >&2
        exit 1
    fi
fi

if [ -n "$RELAY_NETWORK" ] \
    && ! run_docker network inspect "$RELAY_NETWORK" >/dev/null 2>&1; then
    echo "Relay network $RELAY_NETWORK does not exist." >&2
    exit 1
fi

candidate_image_id=$(run_docker image inspect -f '{{.Id}}' "$RELAY_TAG")
if [[ ! "$candidate_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Could not resolve the candidate image for the state rollback helper." >&2
    exit 1
fi

if run_docker container inspect "$rollback_name" >/dev/null 2>&1; then
    echo "Rollback container $rollback_name already exists; inspect it before another rollout." >&2
    exit 1
fi
if [ "$RELAY_REMOVE_EXISTING" != "1" ] \
    && run_docker container inspect "$RELAY_NAME" >/dev/null 2>&1; then
    echo "Container $RELAY_NAME already exists. Set RELAY_REMOVE_EXISTING=1 for a staged replacement." >&2
    exit 1
fi

export RUST_LOG="${RUST_LOG:-info}"
export RELAY_ALLOWED_ORIGINS
export RELAY_TRUSTED_PROXIES
export RELAY_STATE_FILE="$state_file"

run_args=(
    --name "$RELAY_NAME"
    --init
    --read-only
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777
    --security-opt no-new-privileges:true
    --cap-drop ALL
    --pids-limit "$RELAY_PIDS_LIMIT"
    --memory "$RELAY_MEMORY_LIMIT"
    --cpus "$RELAY_CPU_LIMIT"
    --log-driver json-file
    --log-opt "max-size=${RELAY_LOG_MAX_SIZE}"
    --log-opt "max-file=${RELAY_LOG_MAX_FILES}"
    -e RUST_LOG
    -e RELAY_JWT_SECRET
    -e RELAY_ALLOWED_ORIGINS
    -e RELAY_TRUSTED_PROXIES
    -e RELAY_STATE_FILE
    --mount "type=volume,src=${RELAY_STATE_VOLUME},dst=${state_mount_destination}"
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

if [ "$RELAY_REMOVE_EXISTING" = "1" ] \
    && run_docker container inspect "$RELAY_NAME" >/dev/null 2>&1; then
    current_state_file=$(run_docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$RELAY_NAME" \
        | sed -n 's/^RELAY_STATE_FILE=//p' | head -n 1)
    current_state_file="${current_state_file:-$state_file}"
    current_state_mount=$(run_docker inspect "$RELAY_NAME" \
        | jq -r --arg volume "$RELAY_STATE_VOLUME" \
            '.[0].Mounts[] | select(.Type == "volume" and .Name == $volume) | .Destination' \
        | head -n 1)
    if [ "$current_state_file" != "$state_file" ] \
        || [ "$current_state_mount" != "$state_mount_destination" ]; then
        echo "Current relay does not use the exact requested durable state volume and path; refusing replacement." >&2
        exit 1
    fi
    current_image_id=$(run_docker inspect -f '{{.Image}}' "$RELAY_NAME")
    if [[ ! "$current_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        echo "Could not resolve the current relay image for rollback." >&2
        exit 1
    fi

    trap restore_previous_relay EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    previous_stopped=1
    run_docker stop --time 20 "$RELAY_NAME" >/dev/null
    run_docker rename "$RELAY_NAME" "$rollback_name"
    previous_renamed=1
    backup_relay_state
else
    current_image_id="$candidate_image_id"
    backup_relay_state
fi

trap restore_previous_relay EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$RELAY_NETWORK" ]; then
    echo "Starting Conductor Relay on network $RELAY_NETWORK as $RELAY_NETWORK_ALIAS..."
else
    if [ -n "$RELAY_PORT" ]; then
        echo "Starting Conductor Relay on port $RELAY_PORT..."
    else
        echo "Starting Conductor Relay without publishing a host port..."
    fi
fi

candidate_started=1
if [ "$RELAY_DETACH" = "1" ]; then
    export RELAY_JWT_SECRET
    run_docker run "${run_args[@]}" "$RELAY_TAG" >/dev/null
    unset RELAY_JWT_SECRET

    ready=0
    for _ in $(seq 1 30); do
        health_json=$(run_docker exec "$RELAY_NAME" \
            curl --connect-timeout 2 --max-time 5 -fsS \
            http://127.0.0.1:8080/health 2>/dev/null || true)
        if jq -e '.ok == true and .ready == true' \
            <<< "$health_json" >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 2
    done
    if [ "$ready" -ne 1 ]; then
        echo "New relay did not become ready; rolling back." >&2
        exit 1
    fi

    if [ -n "$RELAY_HEALTHCHECK_URL" ]; then
        candidate_build_sha=$(jq -r '.buildSha // empty' <<< "$health_json")
        public_ready=0
        for _ in $(seq 1 10); do
            public_health=$(curl --connect-timeout 3 --max-time 8 -fsS \
                "$RELAY_HEALTHCHECK_URL" 2>/dev/null || true)
            if jq -e --arg expected "$candidate_build_sha" \
                '.ok == true and .ready == true and .buildSha == $expected' \
                <<< "$public_health" >/dev/null 2>&1; then
                public_ready=1
                break
            fi
            sleep 3
        done
        if [ "$public_ready" -ne 1 ]; then
            echo "Public relay endpoint did not report the candidate build; rolling back." >&2
            exit 1
        fi
    fi

    trap - EXIT INT TERM
    previous_stopped=0
    previous_renamed=0
    candidate_started=0
    if run_docker container inspect "$rollback_name" >/dev/null 2>&1 \
        && ! run_docker rm "$rollback_name" >/dev/null; then
        cleanup_state_backup
        echo "The new relay is ready, but the stopped rollback container could not be removed." >&2
        exit 1
    fi
    cleanup_state_backup
    echo "Conductor Relay is ready."
else
    export RELAY_JWT_SECRET
    run_docker run "${run_args[@]}" "$RELAY_TAG"
    unset RELAY_JWT_SECRET
fi
