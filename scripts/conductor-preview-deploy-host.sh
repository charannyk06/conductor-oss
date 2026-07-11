#!/usr/bin/env bash
# Restricted SSH forced command for the production Conductor preview worker.
set -Eeuo pipefail

container_name="preview-worker-preview-worker-1"
rollback_name="preview-worker-preview-worker-rollback"
network_name="clawcloud_default"
network_alias="conductor-preview-worker"
public_health_url="https://preview-worker.cmm77659.217.216.95.110.sslip.io/health"
docker_command_timeout_seconds=45

run_docker() {
  timeout --foreground --kill-after=5s "${docker_command_timeout_seconds}s" docker "$@"
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
if [[ ! "$original_command" =~ ^deploy\ (ghcr\.io/charannyk06/conductor-preview-worker@sha256:[0-9a-f]{64})\ ([0-9a-f]{40})$ ]]; then
  echo "Denied: expected a digest-pinned Conductor preview deployment command." >&2
  exit 64
fi

image_ref="${BASH_REMATCH[1]}"
expected_sha="${BASH_REMATCH[2]}"

exec 9>/var/lock/conductor-preview-deploy.lock
if ! flock -n 9; then
  echo "Another Conductor preview deployment is already running." >&2
  exit 75
fi

if run_docker container inspect "$rollback_name" >/dev/null 2>&1; then
  echo "Refusing to deploy while $rollback_name exists; inspect the prior rollback first." >&2
  exit 70
fi

current_env=$(run_docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container_name")
worker_api_key=$(sed -n 's/^WORKER_API_KEY=//p' <<< "$current_env" | head -n 1)
worker_session_timeout=$(sed -n 's/^WORKER_SESSION_TIMEOUT_MS=//p' <<< "$current_env" | head -n 1)
worker_max_sessions=$(sed -n 's/^WORKER_MAX_SESSIONS=//p' <<< "$current_env" | head -n 1)
worker_session_timeout="${worker_session_timeout:-600000}"
worker_max_sessions="${worker_max_sessions:-5}"
unset current_env

worker_key_bytes=$(LC_ALL=C printf '%s' "$worker_api_key" | wc -c | tr -d ' ')
if [ "$worker_key_bytes" -lt 32 ]; then
  echo "Current preview worker API key is weaker than 32 bytes; rotate it before deployment." >&2
  exit 78
fi
if [[ ! "$worker_session_timeout" =~ ^[0-9]+$ ]] \
  || [ "$worker_session_timeout" -lt 1000 ] \
  || [ "$worker_session_timeout" -gt 3600000 ]; then
  echo "Current preview session timeout is outside the supported range." >&2
  exit 78
fi
if [[ ! "$worker_max_sessions" =~ ^[0-9]+$ ]] \
  || [ "$worker_max_sessions" -lt 1 ] \
  || [ "$worker_max_sessions" -gt 20 ]; then
  echo "Current preview session cap is outside the supported range." >&2
  exit 78
fi
if ! run_docker network inspect "$network_name" >/dev/null 2>&1; then
  echo "Preview network $network_name is missing; refusing to deploy." >&2
  exit 78
fi

timeout --foreground --kill-after=10s 300s docker pull "$image_ref" >/dev/null

previous_stopped=0
previous_renamed=0
restore_previous_worker() {
  status=$?
  trap - EXIT INT TERM
  if run_docker container inspect "$rollback_name" >/dev/null 2>&1; then
    previous_renamed=1
  else
    previous_renamed=0
  fi
  if [ "$previous_renamed" -eq 1 ]; then
    echo "Deployment failed; restoring the previous preview worker." >&2
    if run_docker container inspect "$container_name" >/dev/null 2>&1; then
      run_docker rm -f "$container_name" >/dev/null
    fi
    if ! run_docker rename "$rollback_name" "$container_name"; then
      echo "CRITICAL: failed to restore the previous preview worker name." >&2
      exit 90
    fi
    if ! run_docker start "$container_name" >/dev/null; then
      echo "CRITICAL: failed to restart the previous preview worker." >&2
      exit 91
    fi
  elif [ "$previous_stopped" -eq 1 ]; then
    echo "Deployment failed before rename; restarting the current preview worker." >&2
    if ! run_docker start "$container_name" >/dev/null; then
      echo "CRITICAL: failed to restart the current preview worker." >&2
      exit 91
    fi
  fi

  if [ "$previous_stopped" -eq 1 ]; then
    restored=0
    for _ in $(seq 1 15); do
      health_json=$(run_docker exec "$container_name" \
        wget -qO- -T 5 http://127.0.0.1:3099/health 2>/dev/null || true)
      if jq -e '.ok == true' <<< "$health_json" >/dev/null 2>&1; then
        restored=1
        break
      fi
      sleep 2
    done
    if [ "$restored" -ne 1 ]; then
      echo "CRITICAL: previous preview worker restarted but did not become healthy." >&2
      exit 92
    fi
  fi
  exit "$status"
}
trap restore_previous_worker EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

previous_stopped=1
run_docker stop --time 20 "$container_name" >/dev/null
run_docker rename "$container_name" "$rollback_name"
previous_renamed=1

export WORKER_API_KEY="$worker_api_key"
export WORKER_SESSION_TIMEOUT_MS="$worker_session_timeout"
export WORKER_MAX_SESSIONS="$worker_max_sessions"
unset worker_api_key

run_docker run -d \
  --restart unless-stopped \
  --name "$container_name" \
  --init \
  --network "$network_name" \
  --network-alias "$network_alias" \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --pids-limit 512 \
  --memory 4g \
  --cpus 2 \
  --shm-size 512m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1073741824,mode=1777 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --health-cmd 'wget -qO- -T 5 http://127.0.0.1:3099/health >/dev/null || exit 1' \
  --health-interval 30s \
  --health-timeout 6s \
  --health-start-period 20s \
  --health-retries 3 \
  -e WORKER_PORT=3099 \
  -e WORKER_API_KEY \
  -e WORKER_SESSION_TIMEOUT_MS \
  -e WORKER_MAX_SESSIONS \
  -e HOME=/tmp \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
  -e CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX=false \
  "$image_ref" >/dev/null
unset WORKER_API_KEY

healthy=0
for _ in $(seq 1 30); do
  health_json=$(run_docker exec "$container_name" \
    wget -qO- -T 5 http://127.0.0.1:3099/health 2>/dev/null || true)
  if jq -e --arg expected "$expected_sha" \
    '.ok == true and .buildSha == $expected' \
    <<< "$health_json" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "New preview worker did not report the requested build." >&2
  exit 1
fi

session_json=$(run_docker exec "$container_name" node -e '
const fail = (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};
fetch("http://127.0.0.1:3099/sessions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.WORKER_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: "{}",
  signal: AbortSignal.timeout(30_000),
})
  .then(async (response) => {
    const body = await response.text();
    if (!response.ok) throw new Error(`session launch failed (${response.status}): ${body}`);
    process.stdout.write(body);
  })
  .catch(fail);
')
session_id=$(jq -r '.sessionId // empty' <<< "$session_json")
if [ -z "$session_id" ]; then
  echo "New preview worker could not launch a sandboxed browser session." >&2
  exit 1
fi
run_docker exec -e PREVIEW_SMOKE_SESSION_ID="$session_id" "$container_name" node -e '
const fail = (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};
fetch(`http://127.0.0.1:3099/sessions/${encodeURIComponent(process.env.PREVIEW_SMOKE_SESSION_ID)}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${process.env.WORKER_API_KEY}` },
  signal: AbortSignal.timeout(10_000),
})
  .then(async (response) => {
    if (!response.ok) throw new Error(`session cleanup failed (${response.status}): ${await response.text()}`);
  })
  .catch(fail);
' >/dev/null

upstream_health=$(run_docker exec clawcloud-caddy-1 \
  curl --connect-timeout 2 --max-time 5 -fsS \
  http://conductor-preview-worker:3099/health)
if ! jq -e --arg expected "$expected_sha" \
  '.ok == true and .buildSha == $expected' \
  <<< "$upstream_health" >/dev/null; then
  echo "Caddy cannot reach the requested preview worker build." >&2
  exit 1
fi

public_ready=0
for _ in $(seq 1 10); do
  public_health=$(curl --connect-timeout 3 --max-time 8 -fsS "$public_health_url" 2>/dev/null || true)
  if jq -e --arg expected "$expected_sha" \
    '.ok == true and .buildSha == $expected' \
    <<< "$public_health" >/dev/null 2>&1; then
    public_ready=1
    break
  fi
  sleep 3
done
if [ "$public_ready" -ne 1 ]; then
  echo "Public preview endpoint did not report the requested build." >&2
  exit 1
fi

trap - EXIT INT TERM
previous_stopped=0
previous_renamed=0
if ! run_docker rm "$rollback_name" >/dev/null; then
  echo "The new preview worker is healthy, but the stopped rollback container could not be removed." >&2
  exit 93
fi
echo "Preview worker deployment completed for $expected_sha."
