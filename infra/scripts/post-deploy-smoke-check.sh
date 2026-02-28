#!/usr/bin/env bash
set -euo pipefail

# Post-deploy smoke check contract
# Required env:
# - SMOKE_API_HEALTH_URL: API health endpoint URL (expected 2xx)
# - SMOKE_WEB_HEALTH_URL: Web health endpoint URL (expected 2xx)
# Optional env:
# - SMOKE_TIMEOUT_SECONDS (default: 15)
# - SMOKE_RETRY_COUNT (default: 6)
# - SMOKE_RETRY_DELAY_SECONDS (default: 10)

: "${SMOKE_API_HEALTH_URL:?SMOKE_API_HEALTH_URL is required}"
: "${SMOKE_WEB_HEALTH_URL:?SMOKE_WEB_HEALTH_URL is required}"

SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-15}"
SMOKE_RETRY_COUNT="${SMOKE_RETRY_COUNT:-6}"
SMOKE_RETRY_DELAY_SECONDS="${SMOKE_RETRY_DELAY_SECONDS:-10}"

check_endpoint() {
  local name="$1"
  local url="$2"
  local attempts=1

  while (( attempts <= SMOKE_RETRY_COUNT )); do
    local status_code
    status_code="$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time "${SMOKE_TIMEOUT_SECONDS}" "$url" || true)"

    if [[ "$status_code" =~ ^2[0-9][0-9]$ ]]; then
      echo "✅ ${name} ok (${status_code}) - ${url}"
      return 0
    fi

    echo "⚠️ ${name} failed attempt ${attempts}/${SMOKE_RETRY_COUNT} (status=${status_code:-curl_error}) - ${url}"

    if (( attempts < SMOKE_RETRY_COUNT )); then
      sleep "$SMOKE_RETRY_DELAY_SECONDS"
    fi

    attempts=$((attempts + 1))
  done

  echo "❌ ${name} smoke check failed after ${SMOKE_RETRY_COUNT} attempts"
  return 1
}

echo "Running post-deploy smoke checks..."
check_endpoint "api" "$SMOKE_API_HEALTH_URL"
check_endpoint "web" "$SMOKE_WEB_HEALTH_URL"
echo "✅ Post-deploy smoke checks passed"
