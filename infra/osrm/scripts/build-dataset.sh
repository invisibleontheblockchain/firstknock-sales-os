#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OSRM_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${OSRM_ENV_FILE:-$OSRM_DIR/osrm.env}"
if [[ -f "$ENV_FILE" ]]; then
  if ! command -v sed >/dev/null 2>&1; then
    echo "Missing required command for loading $ENV_FILE: sed" >&2
    exit 2
  fi
  set -a
  # Strip CR characters so a file edited on Windows is still safe to load.
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
fi

IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:26.7.3-debian@sha256:a7091038e39a73659767f34ef2d389909b42ea80b09bd2bdca482dce2991cbad}"
REGION_URL="${OSRM_REGION_URL:-https://download.geofabrik.de/north-america/us-latest.osm.pbf}"
PROFILE_FILE="${OSRM_PROFILE_FILE:-foot.lua}"
DATA_ROOT="${OSRM_DATA_ROOT:-}"
DATASET_BASE="${OSRM_DATASET_BASE:-us.osrm}"
COVERAGE_ID="${OSRM_COVERAGE_ID:-us-50-states-dc}"
MIN_BUILD_RAM_GIB="${OSRM_MIN_BUILD_RAM_GIB:-176}"
MIN_BUILD_FREE_DISK_GIB="${OSRM_MIN_BUILD_FREE_DISK_GIB:-800}"
PROFILE_NAME="${PROFILE_FILE%.lua}"
API_PROFILE="${OSRM_API_PROFILE:-$PROFILE_NAME}"
BUILD_ID="${OSRM_BUILD_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$COVERAGE_ID-$PROFILE_NAME}"

if [[ ! "$BUILD_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "OSRM_BUILD_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
  exit 2
fi

if [[ ! "$DATASET_BASE" =~ ^[A-Za-z0-9._-]+\.osrm$ ]]; then
  echo "OSRM_DATASET_BASE must be a simple filename ending in .osrm." >&2
  exit 2
fi

if [[ ! "$COVERAGE_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "OSRM_COVERAGE_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
  exit 2
fi

if [[ "$COVERAGE_ID" != "us-50-states-dc" ]]; then
  echo "This scaffold only builds the nationwide us-50-states-dc coverage contract." >&2
  exit 2
fi

if [[ ! "$REGION_URL" =~ ^https://download\.geofabrik\.de/north-america/us-(latest|[0-9]{6})\.osm\.pbf$ ]]; then
  echo "OSRM_REGION_URL must be an official Geofabrik whole-United-States latest or dated extract." >&2
  exit 2
fi

if [[ ! "$PROFILE_FILE" =~ ^[A-Za-z0-9._-]+\.lua$ ]]; then
  echo "OSRM_PROFILE_FILE must be a simple filename ending in .lua." >&2
  exit 2
fi

if [[ -z "$DATA_ROOT" || "$DATA_ROOT" != /* || "$DATA_ROOT" == *CHANGE_ME* ]]; then
  echo "Set OSRM_DATA_ROOT to an explicit absolute path on dedicated build storage." >&2
  exit 2
fi

if [[ "${DATA_ROOT,,}" == *onedrive* ]]; then
  echo "OSRM_DATA_ROOT must not be inside a OneDrive-synchronized path." >&2
  exit 2
fi

if [[ ! "$MIN_BUILD_RAM_GIB" =~ ^[1-9][0-9]*$ || ! "$MIN_BUILD_FREE_DISK_GIB" =~ ^[1-9][0-9]*$ ]]; then
  echo "OSRM build RAM and free-disk thresholds must be positive whole GiB values." >&2
  exit 2
fi

if [[ ! "$IMAGE" =~ @sha256:[0-9A-Fa-f]{64}$ ]]; then
  echo "OSRM_IMAGE must end with a 64-character @sha256 digest pin." >&2
  exit 2
fi

if [[ "$API_PROFILE" != "$PROFILE_NAME" ]]; then
  echo "OSRM_API_PROFILE ($API_PROFILE) must match OSRM_PROFILE_FILE without .lua ($PROFILE_NAME)." >&2
  exit 2
fi

for command_name in awk cp curl df docker md5sum mv sed sha256sum tee tr wc; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 2
  fi
done

mkdir -p "$DATA_ROOT/builds" "$DATA_ROOT/downloads"
DATA_ROOT="$(cd -- "$DATA_ROOT" && pwd)"
BUILD_DIR="$DATA_ROOT/builds/$BUILD_ID"

FREE_DISK_KIB="$(df -Pk "$DATA_ROOT" | awk 'NR == 2 { print $4 }')"
MIN_FREE_DISK_KIB="$((MIN_BUILD_FREE_DISK_GIB * 1024 * 1024))"
if [[ ! "$FREE_DISK_KIB" =~ ^[0-9]+$ || "$FREE_DISK_KIB" -lt "$MIN_FREE_DISK_KIB" ]]; then
  echo "OSRM_DATA_ROOT needs at least $MIN_BUILD_FREE_DISK_GIB GiB free before a national build." >&2
  exit 2
fi

if ! DOCKER_MEMORY_BYTES="$(docker info --format '{{.MemTotal}}')"; then
  echo "Could not read Docker Engine memory capacity." >&2
  exit 2
fi
MIN_BUILD_MEMORY_BYTES="$((MIN_BUILD_RAM_GIB * 1024 * 1024 * 1024))"
if [[ ! "$DOCKER_MEMORY_BYTES" =~ ^[0-9]+$ || "$DOCKER_MEMORY_BYTES" -lt "$MIN_BUILD_MEMORY_BYTES" ]]; then
  echo "Docker Engine needs at least $MIN_BUILD_RAM_GIB GiB RAM for the national build envelope." >&2
  exit 2
fi

if [[ -e "$BUILD_DIR" ]]; then
  echo "Refusing to overwrite existing build directory: $BUILD_DIR" >&2
  exit 2
fi

URL_HASH="$(printf '%s' "$REGION_URL" | sha256sum | awk '{ print $1 }')"
DOWNLOAD_CHECKSUM_PATH="$DATA_ROOT/downloads/$URL_HASH.md5.source"
curl --fail --location --retry 3 --retry-all-errors \
  --output "$DOWNLOAD_CHECKSUM_PATH" "${REGION_URL}.md5"

EXPECTED_MD5="$(awk 'NR == 1 { print $1 }' "$DOWNLOAD_CHECKSUM_PATH" | tr '[:upper:]' '[:lower:]')"
if [[ ! "$EXPECTED_MD5" =~ ^[0-9a-f]{32}$ ]]; then
  echo "Geofabrik returned an invalid MD5 checksum." >&2
  exit 1
fi

CACHED_PBF_PATH="$DATA_ROOT/downloads/$EXPECTED_MD5.osm.pbf"
ACTUAL_MD5=""
if [[ -f "$CACHED_PBF_PATH" ]]; then
  ACTUAL_MD5="$(md5sum "$CACHED_PBF_PATH" | awk '{ print $1 }')"
fi

if [[ "$ACTUAL_MD5" != "$EXPECTED_MD5" ]]; then
  echo "Downloading $REGION_URL"
  if curl --fail --location --retry 3 --retry-all-errors --continue-at - \
    --output "$CACHED_PBF_PATH" "$REGION_URL"; then
    ACTUAL_MD5="$(md5sum "$CACHED_PBF_PATH" | awk '{ print $1 }')"
  else
    echo "Resume failed; downloading one clean replacement copy." >&2
  fi
fi

if [[ "$EXPECTED_MD5" != "$ACTUAL_MD5" ]]; then
  FRESH_PBF_PATH="$CACHED_PBF_PATH.fresh"
  echo "Cached/resumed PBF failed its checksum; downloading $FRESH_PBF_PATH" >&2
  curl --fail --location --retry 3 --retry-all-errors \
    --output "$FRESH_PBF_PATH" "$REGION_URL"
  FRESH_MD5="$(md5sum "$FRESH_PBF_PATH" | awk '{ print $1 }')"
  if [[ "$EXPECTED_MD5" != "$FRESH_MD5" ]]; then
    echo "Geofabrik checksum verification failed for the clean replacement." >&2
    echo "Inspect or remove the failed cache file: $FRESH_PBF_PATH" >&2
    exit 1
  fi
  mv -f -- "$FRESH_PBF_PATH" "$CACHED_PBF_PATH"
  ACTUAL_MD5="$FRESH_MD5"
fi

mkdir -p "$BUILD_DIR"
CHECKSUM_PATH="$BUILD_DIR/source.osm.pbf.md5.source"
cp "$DOWNLOAD_CHECKSUM_PATH" "$CHECKSUM_PATH"

PBF_SHA256="$(sha256sum "$CACHED_PBF_PATH" | awk '{ print $1 }')"
SOURCE_BYTES="$(wc -c < "$CACHED_PBF_PATH" | tr -d '[:space:]')"

docker pull "$IMAGE"
PROFILE_SHA256="$(docker run --rm --entrypoint sha256sum "$IMAGE" "/opt/$PROFILE_FILE" | awk '{ print $1 }')"
if [[ -z "$PROFILE_SHA256" ]]; then
  echo "Could not hash /opt/$PROFILE_FILE from the pinned image." >&2
  exit 1
fi

run_stage() {
  local stage="$1"
  shift
  echo "Starting $stage at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  time "$@" 2>&1 | tee "$BUILD_DIR/$stage.log"
}

run_stage extract docker run --rm \
  -v "$CACHED_PBF_PATH:/input/source.osm.pbf:ro" \
  -v "$BUILD_DIR:/data" \
  "$IMAGE" \
  osrm-extract -p "/opt/$PROFILE_FILE" --data_version "$BUILD_ID" \
  --output "/data/$DATASET_BASE" /input/source.osm.pbf

run_stage partition docker run --rm \
  -v "$BUILD_DIR:/data" \
  "$IMAGE" \
  osrm-partition "/data/$DATASET_BASE"

run_stage customize docker run --rm \
  -v "$BUILD_DIR:/data" \
  "$IMAGE" \
  osrm-customize "/data/$DATASET_BASE"

run_stage trial docker run --rm \
  -v "$BUILD_DIR:/data:ro" \
  "$IMAGE" \
  osrm-routed --algorithm mld --trial "/data/$DATASET_BASE"

(
  cd -- "$BUILD_DIR"
  sha256sum "$DATASET_BASE"* > osrm-artifacts.sha256
  : > osrm-artifacts.sizes
  for artifact_path in "$DATASET_BASE"*; do
    wc -c "$artifact_path" >> osrm-artifacts.sizes
  done
)
ARTIFACT_BYTES="$(awk '{ total += $1 } END { print total }' "$BUILD_DIR/osrm-artifacts.sizes")"
ARTIFACT_MANIFEST_SHA256="$(sha256sum "$BUILD_DIR/osrm-artifacts.sha256" | awk '{ print $1 }')"
BUILD_FINGERPRINT="$(
  printf '%s\n' \
    "artifact_manifest_sha256=$ARTIFACT_MANIFEST_SHA256" \
    "image=$IMAGE" \
    | sha256sum \
    | awk '{ print $1 }'
)"

cat > "$BUILD_DIR/build-metadata.txt" <<EOF
build_id=$BUILD_ID
build_fingerprint=$BUILD_FINGERPRINT
coverage_id=$COVERAGE_ID
dataset_base=$DATASET_BASE
region_url=$REGION_URL
source_bytes=$SOURCE_BYTES
artifact_bytes=$ARTIFACT_BYTES
artifact_manifest_sha256=$ARTIFACT_MANIFEST_SHA256
build_start_free_disk_kib=$FREE_DISK_KIB
docker_memory_bytes=$DOCKER_MEMORY_BYTES
pbf_md5=$ACTUAL_MD5
pbf_sha256=$PBF_SHA256
profile_file=$PROFILE_FILE
profile_sha256=$PROFILE_SHA256
api_profile=$API_PROFILE
image=$IMAGE
created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo
echo "Build validated: $BUILD_DIR"
echo "Set OSRM_DATA_DIR=$BUILD_DIR"
echo "Set OSRM_DATA_VERSION=$BUILD_ID"
echo "Set OSRM_BUILD_FINGERPRINT=$BUILD_FINGERPRINT"
