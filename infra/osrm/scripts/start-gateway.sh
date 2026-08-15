#!/bin/sh
set -eu

require_64_hex() {
  value="$1"
  name="$2"
  if [ "${#value}" -ne 64 ]; then
    echo "$name must contain exactly 64 hexadecimal characters." >&2
    exit 1
  fi
  case "$value" in
    *[!0-9A-Fa-f]*)
      echo "$name must contain exactly 64 hexadecimal characters." >&2
      exit 1
      ;;
  esac
}

require_safe_label() {
  value="$1"
  name="$2"
  case "$value" in
    ''|*[!A-Za-z0-9._-]*)
      echo "$name may contain only letters, numbers, dots, underscores, and hyphens." >&2
      exit 1
      ;;
  esac
}

require_64_hex "$OSRM_GATEWAY_TOKEN" OSRM_GATEWAY_TOKEN
require_64_hex "$OSRM_BUILD_FINGERPRINT" OSRM_BUILD_FINGERPRINT
require_safe_label "$OSRM_API_PROFILE" OSRM_API_PROFILE
require_safe_label "$OSRM_COVERAGE_ID" OSRM_COVERAGE_ID
require_safe_label "$OSRM_DATA_VERSION" OSRM_DATA_VERSION

if [ "$OSRM_COVERAGE_ID" != "us-50-states-dc" ]; then
  echo "OSRM_COVERAGE_ID must be us-50-states-dc for this nationwide gateway." >&2
  exit 1
fi

exec /docker-entrypoint.sh nginx -g "daemon off;"
