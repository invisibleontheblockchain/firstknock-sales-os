#!/bin/sh
set -eu

METADATA_PATH=/data/build-metadata.txt

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

require_64_hex "$OSRM_BUILD_FINGERPRINT" OSRM_BUILD_FINGERPRINT
require_safe_label "$OSRM_DATA_VERSION" OSRM_DATA_VERSION
require_safe_label "$OSRM_COVERAGE_ID" OSRM_COVERAGE_ID
require_safe_label "$OSRM_DATASET_BASE" OSRM_DATASET_BASE
require_safe_label "$OSRM_PROFILE_FILE" OSRM_PROFILE_FILE
require_safe_label "$OSRM_API_PROFILE" OSRM_API_PROFILE

if [ "$OSRM_COVERAGE_ID" != "us-50-states-dc" ]; then
  echo "OSRM_COVERAGE_ID must be us-50-states-dc for this nationwide service." >&2
  exit 1
fi
case "$OSRM_DATASET_BASE" in
  *.osrm) ;;
  *)
    echo "OSRM_DATASET_BASE must end in .osrm." >&2
    exit 1
    ;;
esac
case "$OSRM_PROFILE_FILE" in
  *.lua) ;;
  *)
    echo "OSRM_PROFILE_FILE must end in .lua." >&2
    exit 1
    ;;
esac
if [ "$OSRM_API_PROFILE" != "${OSRM_PROFILE_FILE%.lua}" ]; then
  echo "OSRM_API_PROFILE must match OSRM_PROFILE_FILE without .lua." >&2
  exit 1
fi
case "$OSRM_EXPECTED_IMAGE" in
  *@sha256:*) IMAGE_DIGEST="${OSRM_EXPECTED_IMAGE##*@sha256:}" ;;
  *)
    echo "OSRM_EXPECTED_IMAGE must include an @sha256 digest pin." >&2
    exit 1
    ;;
esac
require_64_hex "$IMAGE_DIGEST" OSRM_EXPECTED_IMAGE_DIGEST

if [ ! -r "$METADATA_PATH" ]; then
  echo "Missing readable OSRM build metadata: $METADATA_PATH" >&2
  exit 1
fi

require_metadata() {
  if ! grep -Fqx "$1=$2" "$METADATA_PATH"; then
    echo "OSRM build metadata mismatch for $1." >&2
    exit 1
  fi
}

require_metadata build_id "$OSRM_DATA_VERSION"
require_metadata build_fingerprint "$OSRM_BUILD_FINGERPRINT"
require_metadata coverage_id "$OSRM_COVERAGE_ID"
require_metadata dataset_base "$OSRM_DATASET_BASE"
require_metadata image "$OSRM_EXPECTED_IMAGE"
require_metadata profile_file "$OSRM_PROFILE_FILE"
require_metadata api_profile "$OSRM_API_PROFILE"

PROFILE_SHA256="$(sha256sum "/opt/$OSRM_PROFILE_FILE" | awk '{ print $1 }')"
require_metadata profile_sha256 "$PROFILE_SHA256"

if [ ! -r /data/osrm-artifacts.sha256 ]; then
  echo "Missing readable OSRM artifact checksum manifest." >&2
  exit 1
fi

ARTIFACT_MANIFEST_SHA256="$(sha256sum /data/osrm-artifacts.sha256 | awk '{ print $1 }')"
CALCULATED_BUILD_FINGERPRINT="$(
  printf '%s\n' \
    "artifact_manifest_sha256=$ARTIFACT_MANIFEST_SHA256" \
    "image=$OSRM_EXPECTED_IMAGE" \
    | sha256sum \
    | awk '{ print $1 }'
)"
if [ "$CALCULATED_BUILD_FINGERPRINT" != "$OSRM_BUILD_FINGERPRINT" ]; then
  echo "OSRM artifacts/runtime do not match the promoted build fingerprint." >&2
  exit 1
fi
require_metadata artifact_manifest_sha256 "$ARTIFACT_MANIFEST_SHA256"
(cd /data && sha256sum -c osrm-artifacts.sha256)

export DISABLE_ACCESS_LOGGING=1
exec osrm-routed \
  --algorithm mld \
  --verbosity ERROR \
  --threads "$OSRM_THREADS" \
  --max-table-size "$OSRM_MAX_TABLE_SIZE" \
  --max-viaroute-size "$OSRM_MAX_ROUTE_SIZE" \
  --default-radius "$OSRM_DEFAULT_RADIUS_METERS" \
  "/data/$OSRM_DATASET_BASE"
