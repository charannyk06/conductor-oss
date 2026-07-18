#!/usr/bin/env bash
set -euo pipefail

app_origin="${CONDUCTOR_APP_ORIGIN:-https://app.conductross.com}"
preview_origin="${CONDUCTOR_PREVIEW_ORIGIN:-https://preview.conductross.com}"
relay_origin="${CONDUCTOR_RELAY_ORIGIN:-https://relay.conductross.com}"
expected_build_sha="${EXPECTED_BUILD_SHA:-}"

for origin in "$app_origin" "$preview_origin" "$relay_origin"; do
  if [[ "$origin" != https://* ]]; then
    echo "Hosted surface origins must use HTTPS: $origin" >&2
    exit 2
  fi
done

scratch_dir=$(mktemp -d)
trap 'rm -rf -- "$scratch_dir"' EXIT

fetch_installer_sha() {
  local origin="$1"
  local label="$2"
  local installer="$scratch_dir/$label-install.sh"

  curl --connect-timeout 5 --max-time 20 \
    --fail --silent --show-error --max-redirs 0 \
    --proto '=https' --proto-redir '=https' \
    "$origin/bridge/install.sh" > "$installer"

  local source_sha
  source_sha=$(sed -n \
    's#^SOURCE_ARCHIVE_URL="https://codeload.github.com/charannyk06/conductor-oss/tar.gz/\([0-9a-f]\{40\}\)"$#\1#p' \
    "$installer")
  if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$label installer does not identify an immutable Conductor source archive." >&2
    exit 1
  fi
  printf '%s' "$source_sha"
}

app_sha=$(fetch_installer_sha "$app_origin" app)
preview_sha=$(fetch_installer_sha "$preview_origin" preview)
if [ "$app_sha" != "$preview_sha" ]; then
  echo "Hosted dashboards are serving different builds: app=$app_sha preview=$preview_sha" >&2
  exit 1
fi
if [ -n "$expected_build_sha" ] && [ "$app_sha" != "$expected_build_sha" ]; then
  echo "Hosted dashboards serve $app_sha, expected $expected_build_sha" >&2
  exit 1
fi

relay_health="$scratch_dir/relay-health.json"
curl --connect-timeout 5 --max-time 20 \
  --fail --silent --show-error --max-redirs 0 \
  --proto '=https' --proto-redir '=https' \
  "$relay_origin/health" > "$relay_health"
jq -e '.ok == true and .ready == true and (.buildSha | type == "string" and length == 40)' \
  "$relay_health" >/dev/null

origin_index=0
for dashboard_origin in "$app_origin" "$preview_origin"; do
  headers="$scratch_dir/relay-$origin_index.headers"
  origin_index=$((origin_index + 1))
  curl --connect-timeout 5 --max-time 20 \
    --fail --silent --show-error --max-redirs 0 \
    --proto '=https' --proto-redir '=https' \
    -D "$headers" -o /dev/null \
    -H "Origin: $dashboard_origin" \
    "$relay_origin/health"
  allowed_origin=$(tr -d '\r' < "$headers" \
    | awk 'tolower($0) ~ /^access-control-allow-origin:[[:space:]]*/ {
        sub(/^[^:]*:[[:space:]]*/, ""); value = $0
      } END { print value }')
  if [ "$allowed_origin" != "$dashboard_origin" ]; then
    echo "Relay did not allow hosted dashboard origin $dashboard_origin" >&2
    exit 1
  fi
done

echo "Hosted surfaces are aligned at $app_sha and relay CORS allows both dashboards."
