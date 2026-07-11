#!/usr/bin/env bash
# Restricted SSH forced command for the production conductor-relay host.
set -Eeuo pipefail

container_name="conductor-relay"
rollback_name="conductor-relay-rollback"
primary_network="clawcloud_default"
secondary_network="clawcloud_clawnet"
state_volume="conductor-relay-state"
state_mount_destination_expected="/var/lib/conductor-relay"
state_file_expected="/var/lib/conductor-relay/state.json"
public_health_url="https://relay.conductross.com/health"
docker_command_timeout_seconds=45
state_backup_dir=""
state_backup_owner=""
state_backup_existed=0
state_backup_ready=0

run_docker() {
  timeout --foreground --kill-after=5s "${docker_command_timeout_seconds}s" docker "$@"
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
  if [ ! -d /dev/shm ] || [ ! -w /dev/shm ]; then
    echo "A writable memory-backed /dev/shm is required for the relay rollback snapshot." >&2
    return 1
  fi

  umask 077
  state_backup_dir=$(mktemp -d /dev/shm/conductor-relay-state.XXXXXX)
  if ! backup_result=$(run_docker run --rm \
    --network none \
    --read-only \
    --user 0:0 \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --mount "type=volume,src=${state_volume},dst=/state,readonly" \
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
      --mount "type=volume,src=${state_volume},dst=/state" \
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
      --mount "type=volume,src=${state_volume},dst=/state" \
      --entrypoint /bin/sh \
      "$current_image_id" \
      -ec 'rm -f -- /state/state.json /state/state.*.tmp /state/.state.json.rollback' \
      >/dev/null
  fi
}

original_command="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$original_command" =~ ^verify-script\ ([0-9a-f]{64})$ ]]; then
  expected_script_sha="${BASH_REMATCH[1]}"
  actual_script_sha=$(sha256sum -- "$0" | awk '{print $1}')
  if [ "$actual_script_sha" != "$expected_script_sha" ]; then
    echo "Deployment command is stale; install the reviewed host script before rollout." >&2
    exit 78
  fi
  echo "Deployment command verified."
  exit 0
fi
if [[ ! "$original_command" =~ ^deploy\ (ghcr\.io/charannyk06/conductor-relay@sha256:[0-9a-f]{64})\ ([0-9a-f]{40})$ ]]; then
  echo "Denied: expected a digest-pinned conductor-relay deployment command." >&2
  exit 64
fi

image_ref="${BASH_REMATCH[1]}"
expected_sha="${BASH_REMATCH[2]}"

exec 9>/var/lock/conductor-relay-deploy.lock
if ! flock -n 9; then
  echo "Another conductor-relay deployment is already running." >&2
  exit 75
fi

if run_docker container inspect "$rollback_name" >/dev/null 2>&1; then
  echo "Refusing to deploy while $rollback_name exists; inspect the prior rollback first." >&2
  exit 70
fi

current_env=$(run_docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container_name")
relay_jwt_secret=$(sed -n 's/^RELAY_JWT_SECRET=//p' <<< "$current_env" | head -n 1)
relay_allowed_origins=$(sed -n 's/^RELAY_ALLOWED_ORIGINS=//p' <<< "$current_env" | head -n 1)
relay_allowed_origins="${relay_allowed_origins:-https://app.conductross.com}"
relay_state_file=$(sed -n 's/^RELAY_STATE_FILE=//p' <<< "$current_env" | head -n 1)
relay_state_file="${relay_state_file:-/var/lib/conductor-relay/state.json}"
unset current_env
state_mount_destination=$(run_docker inspect "$container_name" \
  | jq -r --arg volume "$state_volume" \
    '.[0].Mounts[] | select(.Type == "volume" and .Name == $volume) | .Destination' \
  | head -n 1)

if [ -z "$relay_jwt_secret" ]; then
  echo "Current relay has no JWT secret; refusing to replace it." >&2
  exit 78
fi
relay_secret_bytes=$(LC_ALL=C printf '%s' "$relay_jwt_secret" | wc -c | tr -d ' ')
if [ "$relay_secret_bytes" -lt 32 ]; then
  echo "Current relay JWT secret is weaker than 32 bytes; rotate it before deployment." >&2
  exit 78
fi
if ! run_docker volume inspect "$state_volume" >/dev/null 2>&1; then
  echo "Relay state volume $state_volume is missing; refusing to deploy." >&2
  exit 78
fi
if [ "$state_mount_destination" != "$state_mount_destination_expected" ] \
  || [ "$relay_state_file" != "$state_file_expected" ]; then
  echo "Current relay must use the exact durable state path $state_file_expected; refusing to deploy." >&2
  exit 78
fi
current_image_id=$(run_docker inspect -f '{{.Image}}' "$container_name")
if [[ ! "$current_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Could not resolve the immutable image for the current relay." >&2
  exit 78
fi
if ! run_docker network inspect "$primary_network" >/dev/null 2>&1; then
  echo "Relay network $primary_network is missing; refusing to deploy." >&2
  exit 78
fi
relay_trusted_proxies=$(run_docker inspect clawcloud-caddy-1 \
  | jq -r --arg network "$primary_network" \
    '.[0].NetworkSettings.Networks[$network].IPAddress // empty')
if [ -z "$relay_trusted_proxies" ]; then
  echo "Reverse proxy is not attached to $primary_network; refusing to deploy." >&2
  exit 78
fi

timeout --foreground --kill-after=10s 300s docker pull "$image_ref" >/dev/null

previous_stopped=0
previous_renamed=0
restore_previous_relay() {
  status=$?
  trap - EXIT INT TERM
  if run_docker container inspect "$rollback_name" >/dev/null 2>&1; then
    previous_renamed=1
  else
    previous_renamed=0
  fi
  if [ "$previous_renamed" -eq 1 ]; then
    echo "Deployment failed; restoring the previous relay container." >&2
    if run_docker container inspect "$container_name" >/dev/null 2>&1; then
      run_docker rm -f "$container_name" >/dev/null
    fi
    if ! restore_relay_state; then
      cleanup_state_backup
      echo "CRITICAL: failed to restore the relay state snapshot." >&2
      exit 93
    fi
    if ! run_docker rename "$rollback_name" "$container_name"; then
      cleanup_state_backup
      echo "CRITICAL: failed to restore the previous relay container name." >&2
      exit 90
    fi
    if ! run_docker start "$container_name" >/dev/null; then
      cleanup_state_backup
      echo "CRITICAL: failed to restart the previous relay container." >&2
      exit 91
    fi
  elif [ "$previous_stopped" -eq 1 ]; then
    echo "Deployment failed before rename; restarting the current relay container." >&2
    if ! run_docker start "$container_name" >/dev/null; then
      cleanup_state_backup
      echo "CRITICAL: failed to restart the current relay container." >&2
      exit 91
    fi
  fi

  if [ "$previous_stopped" -eq 1 ]; then
    restored=0
    for _ in $(seq 1 15); do
      health_json=$(run_docker exec "$container_name" \
        curl --connect-timeout 2 --max-time 5 -fsS \
        http://127.0.0.1:8080/health 2>/dev/null || true)
      if jq -e '.ok == true and .ready == true' <<< "$health_json" >/dev/null 2>&1; then
        restored=1
        break
      fi
      sleep 2
    done
    if [ "$restored" -ne 1 ]; then
      cleanup_state_backup
      echo "CRITICAL: previous relay container was restarted but did not become healthy." >&2
      exit 92
    fi
  fi
  cleanup_state_backup
  exit "$status"
}
trap restore_previous_relay EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

previous_stopped=1
run_docker stop --time 20 "$container_name" >/dev/null
run_docker rename "$container_name" "$rollback_name"
previous_renamed=1
backup_relay_state

export RELAY_STATE_FILE="$state_file_expected"
export RELAY_JWT_SECRET="$relay_jwt_secret"
export RELAY_ALLOWED_ORIGINS="$relay_allowed_origins"
export RELAY_TRUSTED_PROXIES="$relay_trusted_proxies"
unset relay_jwt_secret

run_docker run -d \
  --restart unless-stopped \
  --name "$container_name" \
  --init \
  --network "$primary_network" \
  --network-alias conductor-relay \
  --mount "type=volume,src=${state_volume},dst=${state_mount_destination}" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --pids-limit 256 \
  --memory 512m \
  --cpus 1 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  -e RUST_LOG=info \
  -e RELAY_STATE_FILE \
  -e RELAY_JWT_SECRET \
  -e RELAY_ALLOWED_ORIGINS \
  -e RELAY_TRUSTED_PROXIES \
  "$image_ref" >/dev/null
unset RELAY_JWT_SECRET

if run_docker network inspect "$secondary_network" >/dev/null 2>&1; then
  run_docker network connect "$secondary_network" "$container_name" >/dev/null 2>&1 || true
fi

healthy=0
for _ in $(seq 1 30); do
  health_json=$(run_docker exec "$container_name" \
    curl --connect-timeout 2 --max-time 5 -fsS \
    http://127.0.0.1:8080/health 2>/dev/null || true)
  if jq -e --arg expected "$expected_sha" \
    '.ok == true and .ready == true and .buildSha == $expected' \
    <<< "$health_json" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  echo "New relay did not report the requested ready build." >&2
  exit 1
fi

upstream_health=$(run_docker exec clawcloud-caddy-1 \
  curl --connect-timeout 2 --max-time 5 -fsS \
  http://conductor-relay:8080/health)
if ! jq -e --arg expected "$expected_sha" \
  '.ok == true and .ready == true and .buildSha == $expected' \
  <<< "$upstream_health" >/dev/null; then
  echo "Reverse proxy cannot reach the requested ready build." >&2
  exit 1
fi

public_ready=0
for _ in $(seq 1 10); do
  public_health=$(curl --connect-timeout 3 --max-time 8 -fsS "$public_health_url" 2>/dev/null || true)
  if jq -e --arg expected "$expected_sha" \
    '.ok == true and .ready == true and .buildSha == $expected' \
    <<< "$public_health" >/dev/null 2>&1; then
    public_ready=1
    break
  fi
  sleep 3
done
if [ "$public_ready" -ne 1 ]; then
  echo "Public relay endpoint did not report the requested ready build." >&2
  exit 1
fi

trap - EXIT INT TERM
previous_stopped=0
previous_renamed=0
if ! run_docker rm "$rollback_name" >/dev/null; then
  cleanup_state_backup
  echo "The new relay is healthy, but the stopped rollback container could not be removed." >&2
  exit 93
fi
cleanup_state_backup
echo "Relay deployment completed for $expected_sha."
