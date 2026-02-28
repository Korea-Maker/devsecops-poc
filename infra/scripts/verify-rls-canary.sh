#!/usr/bin/env bash
set -euo pipefail

# Staging RLS canary verification (read-only)
#
# Required env when RLS_CANARY_ENABLED=true:
# - RLS_CANARY_API_BASE_URL
# - RLS_CANARY_PROBE_PATH
# - RLS_CANARY_ALLOWED_HEADERS   (pipe-separated curl headers)
# - RLS_CANARY_DENIED_HEADERS    (pipe-separated curl headers)
#
# Optional env:
# - RLS_CANARY_ENABLED (default: false)
# - RLS_CANARY_EXPECT_ALLOWED_STATUS (default: 200)
# - RLS_CANARY_EXPECT_DENIED_STATUSES (default: 401,403,404)
# - RLS_CANARY_TIMEOUT_SECONDS (default: 15)
#
# Header format example:
#   RLS_CANARY_ALLOWED_HEADERS="x-tenant-id: tenant-a|x-user-id: canary|x-user-role: admin"
#   RLS_CANARY_DENIED_HEADERS="x-tenant-id: tenant-b|x-user-id: canary|x-user-role: admin"
#
# This script only sends GET requests and is safe for CI read-only canary checks.

RLS_CANARY_ENABLED="${RLS_CANARY_ENABLED:-false}"
RLS_CANARY_EXPECT_ALLOWED_STATUS="${RLS_CANARY_EXPECT_ALLOWED_STATUS:-200}"
RLS_CANARY_EXPECT_DENIED_STATUSES="${RLS_CANARY_EXPECT_DENIED_STATUSES:-401,403,404}"
RLS_CANARY_TIMEOUT_SECONDS="${RLS_CANARY_TIMEOUT_SECONDS:-15}"

is_true() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

  case "$value" in
    1|true|yes|y|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

append_summary() {
  local title="$1"
  shift

  if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
    return 0
  fi

  {
    echo "### ${title}"
    for line in "$@"; do
      echo "- ${line}"
    done
    echo
  } >> "$GITHUB_STEP_SUMMARY"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

status_in_csv() {
  local status="$1"
  local csv="$2"
  local entry

  IFS=',' read -r -a entries <<< "$csv"
  for entry in "${entries[@]}"; do
    entry="$(trim "$entry")"
    [[ -n "$entry" ]] || continue
    if [[ "$status" == "$entry" ]]; then
      return 0
    fi
  done

  return 1
}

request_status() {
  local url="$1"
  local headers="$2"
  local header
  local -a curl_headers=()

  IFS='|' read -r -a header_items <<< "$headers"
  for header in "${header_items[@]}"; do
    header="$(trim "$header")"
    [[ -n "$header" ]] || continue
    curl_headers+=(-H "$header")
  done

  curl --silent --show-error --output /dev/null \
    --write-out "%{http_code}" \
    --max-time "$RLS_CANARY_TIMEOUT_SECONDS" \
    "${curl_headers[@]}" \
    "$url" || true
}

if ! is_true "$RLS_CANARY_ENABLED"; then
  message="RLS canary skipped: RLS_CANARY_ENABLED is not true."
  echo "ℹ️ ${message}"
  append_summary "ℹ️ RLS Canary Skipped" "$message"
  exit 0
fi

missing=()
for required_env in RLS_CANARY_API_BASE_URL RLS_CANARY_PROBE_PATH RLS_CANARY_ALLOWED_HEADERS RLS_CANARY_DENIED_HEADERS; do
  if [[ -z "${!required_env:-}" ]]; then
    missing+=("$required_env")
  fi
done

if (( ${#missing[@]} > 0 )); then
  message="RLS canary skipped: missing required env(s): ${missing[*]}"
  echo "ℹ️ ${message}"
  append_summary "ℹ️ RLS Canary Skipped" "$message" "Set missing variables/secrets to enable verification."
  exit 0
fi

base_url="${RLS_CANARY_API_BASE_URL%/}"
probe_path="$RLS_CANARY_PROBE_PATH"

if [[ "$probe_path" =~ ^https?:// ]]; then
  probe_url="$probe_path"
else
  [[ "$probe_path" == /* ]] || probe_path="/$probe_path"
  probe_url="${base_url}${probe_path}"
fi

allowed_status="$(request_status "$probe_url" "$RLS_CANARY_ALLOWED_HEADERS")"
denied_status="$(request_status "$probe_url" "$RLS_CANARY_DENIED_HEADERS")"

if ! status_in_csv "$allowed_status" "$RLS_CANARY_EXPECT_ALLOWED_STATUS"; then
  message="Allowed-tenant probe failed: expected ${RLS_CANARY_EXPECT_ALLOWED_STATUS}, got ${allowed_status} (${probe_url})"
  echo "❌ ${message}"
  append_summary "❌ RLS Canary Failed" "$message" "Denied status=${denied_status} (expected one of ${RLS_CANARY_EXPECT_DENIED_STATUSES})"
  exit 1
fi

if ! status_in_csv "$denied_status" "$RLS_CANARY_EXPECT_DENIED_STATUSES"; then
  message="Denied-tenant probe failed: expected one of ${RLS_CANARY_EXPECT_DENIED_STATUSES}, got ${denied_status} (${probe_url})"
  echo "❌ ${message}"
  append_summary "❌ RLS Canary Failed" "$message" "Allowed status=${allowed_status} (expected ${RLS_CANARY_EXPECT_ALLOWED_STATUS})"
  exit 1
fi

success_message="RLS canary passed: allowed=${allowed_status}, denied=${denied_status}, url=${probe_url}"
echo "✅ ${success_message}"
append_summary "✅ RLS Canary Passed" "$success_message"
