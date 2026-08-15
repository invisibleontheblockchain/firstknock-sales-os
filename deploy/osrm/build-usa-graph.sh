#!/usr/bin/env bash
#
# build-usa-graph.sh — Build the full-USA OSRM MLD graph on a temporary build droplet.
#
# Run this on a DESTROY-AFTER-USE droplet, never on the production serving droplet.
# Recommended SKU: m-8vcpu-64gb ($0.50/hr, 64 GB RAM, 200 GB NVMe).
#
# Sizing basis (measured, not assumed — see deploy/osrm/README.md):
#   us-latest.osm.pbf   12.08 GB  (Geofabrik, verified 2026-08-14)
#   .osrm artifacts     ~63 GB    (~5.2x pbf, scaled from a measured 9 GB -> 47 GB build)
#   peak build RAM      ~50-64 GB (the 3-5x multiplier holds; the 12-20x estimate does not)
#   working disk needed ~90 GB    (pbf + artifacts + slack) — 200 GB NVMe is sufficient
#
# The script is idempotent per stage: completed stages are skipped on re-run, so a
# disconnected SSH session does not cost you a restart from zero. Run it under tmux.
#
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/osrm/data}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/north-america/us-latest.osm.pbf}"
PROFILE="${PROFILE:-/opt/car.lua}"
# GHCR, not Docker Hub. `osrm/osrm-backend` on Docker Hub was last pushed in
# July 2021 and is frozen at v5.25.0 — building with it would put a five-year-old
# binary under the whole company. GHCR tags are arch+distro qualified; there is
# no plain `:v26.8.0`.
OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v26.8.0-amd64-debian}"
BASENAME="map"
LOG_DIR="${DATA_DIR}/build-logs"
MIN_FREE_GB="${MIN_FREE_GB:-110}"

mkdir -p "$DATA_DIR" "$LOG_DIR"
BUILD_LOG="${LOG_DIR}/build-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$BUILD_LOG") 2>&1

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '[%s] FATAL: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit 1; }

# --- Pre-flight -------------------------------------------------------------

command -v docker >/dev/null || fail "docker is not installed"

free_gb=$(df -BG --output=avail "$DATA_DIR" | tail -1 | tr -dc '0-9')
log "Free disk at ${DATA_DIR}: ${free_gb} GB (need >= ${MIN_FREE_GB} GB)"
[ "$free_gb" -ge "$MIN_FREE_GB" ] || fail "Not enough disk. Resize the droplet or attach a volume before starting."

ram_gb=$(free -g | awk '/^Mem:/{print $2}')
swap_gb=$(free -g | awk '/^Swap:/{print $2}')
log "RAM: ${ram_gb} GB, swap: ${swap_gb} GB"
if [ "$ram_gb" -lt 60 ] && [ $((ram_gb + swap_gb)) -lt 80 ]; then
  fail "Under-provisioned: need ~64 GB RAM, or RAM+swap >= 80 GB. Add swap (see README) or resize up."
fi
if [ "$swap_gb" -lt 16 ]; then
  log "WARNING: less than 16 GB swap. osrm-extract has no safety net if peak RSS overshoots."
  log "         Create it now with:  fallocate -l 32G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi

# --- Stage 0: download ------------------------------------------------------

PBF="${DATA_DIR}/${BASENAME}.osm.pbf"
if [ -s "$PBF" ]; then
  log "Stage 0 SKIP — ${PBF} already present ($(stat -c%s "$PBF") bytes)"
else
  log "Stage 0 — downloading ${PBF_URL}"
  # Record the exact upstream size/date. Every downstream RAM and disk number
  # scales off this file, so it goes in the deploy log verbatim.
  curl -sIL "$PBF_URL" | grep -iE '^(content-length|last-modified)' | tee "${LOG_DIR}/pbf-headers.txt"
  curl -fL --retry 3 --retry-delay 10 -o "${PBF}.part" "$PBF_URL"
  mv "${PBF}.part" "$PBF"
  log "Stage 0 done — $(du -h "$PBF" | cut -f1)"
fi

# --- Memory sampling --------------------------------------------------------
# Docker stats sampled in the background so we capture real peak RSS. This is
# the measurement that settles the RAM-multiplier question for good; keep it.

sample_memory() {
  local stage="$1" out="${LOG_DIR}/mem-${stage}.log"
  : > "$out"
  while sleep 15; do
    docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}' 2>/dev/null >> "$out" || true
  done
}

peak_from() {
  # Extract the largest GiB figure seen in a stats log.
  awk '{for(i=1;i<=NF;i++) if ($i ~ /GiB$/) {v=$i; sub("GiB","",v); if (v+0>m) m=v+0}} END{printf "%.1f", m}' "$1" 2>/dev/null || echo "0"
}

run_stage() {
  local stage="$1" marker="${DATA_DIR}/.${1}.done"; shift
  if [ -f "$marker" ]; then
    log "Stage ${stage} SKIP — already completed"
    return 0
  fi
  log "Stage ${stage} — starting"
  local t0 sampler_pid
  t0=$(date +%s)
  sample_memory "$stage" & sampler_pid=$!
  # shellcheck disable=SC2064
  trap "kill ${sampler_pid} 2>/dev/null || true" RETURN

  if ! docker run --rm -t \
        -v "${DATA_DIR}:/data" \
        --memory-swappiness=10 \
        "$OSRM_IMAGE" "$@"; then
    kill "$sampler_pid" 2>/dev/null || true
    fail "Stage ${stage} failed. Peak RAM seen: $(peak_from "${LOG_DIR}/mem-${stage}.log") GiB. \
If this was std::bad_alloc, add swap or resize to m-16vcpu-128gb and re-run — completed stages are skipped."
  fi

  kill "$sampler_pid" 2>/dev/null || true
  local elapsed=$(( $(date +%s) - t0 ))
  touch "$marker"
  log "Stage ${stage} done in $((elapsed/60))m$((elapsed%60))s — peak RAM $(peak_from "${LOG_DIR}/mem-${stage}.log") GiB, disk now $(du -sh "$DATA_DIR" | cut -f1)"
}

# --- Stages 1-3: extract / partition / customize ----------------------------

run_stage extract   osrm-extract   -p "$PROFILE" "/data/${BASENAME}.osm.pbf"
run_stage partition osrm-partition "/data/${BASENAME}.osrm"
run_stage customize osrm-customize "/data/${BASENAME}.osrm"

# --- Stage 4: verify --------------------------------------------------------

log "Stage 4 — smoke-testing the built graph"
docker rm -f osrm-buildcheck >/dev/null 2>&1 || true
docker run -d --name osrm-buildcheck -p 5000:5000 -v "${DATA_DIR}:/data" \
  "$OSRM_IMAGE" osrm-routed --algorithm mld "/data/${BASENAME}.osrm" >/dev/null

for i in $(seq 1 30); do
  sleep 5
  if curl -sf "http://127.0.0.1:5000/route/v1/driving/-80.790018,35.593459;-80.788777,35.594156?overview=false" >/dev/null; then
    break
  fi
  [ "$i" -eq 30 ] && { docker logs --tail 50 osrm-buildcheck; fail "Graph did not come up within 150s"; }
done

# Probe both real FirstKnock service areas plus three far-apart national pairs.
# A USA-wide graph that only answers in Charlotte is a build that silently
# truncated; these coordinates are the check for that.
declare -A PROBES=(
  [mooresville-nc]="-80.790018,35.593459;-80.788777,35.594156"
  [belmont-nc]="-81.069989,35.195012;-81.065900,35.190189"
  [seattle-wa]="-122.335167,47.608013;-122.200676,47.610378"
  [austin-tx]="-97.743061,30.267153;-97.669891,30.294088"
  [miami-fl]="-80.191790,25.761680;-80.130045,25.790654"
  [cross-country]="-118.243683,34.052235;-74.005974,40.712776"
)
failures=0
for name in "${!PROBES[@]}"; do
  resp=$(curl -sf "http://127.0.0.1:5000/route/v1/driving/${PROBES[$name]}?overview=false" || echo '{}')
  code=$(printf '%s' "$resp" | grep -o '"code":"[^"]*"' | head -1 | cut -d'"' -f4)
  dist=$(printf '%s' "$resp" | grep -o '"distance":[0-9.]*' | head -1 | cut -d: -f2)
  if [ "$code" = "Ok" ] && [ -n "$dist" ]; then
    log "  PASS ${name}: ${dist} m"
  else
    log "  FAIL ${name}: code=${code:-none}"
    failures=$((failures + 1))
  fi
done

# A 3x3 table probe — the matrix path is what precision generation actually uses,
# so a graph that routes but cannot build a table is not deployable.
if curl -sf "http://127.0.0.1:5000/table/v1/driving/-80.790018,35.593459;-80.788777,35.594156;-80.792000,35.596000?annotations=distance,duration" | grep -q '"code":"Ok"'; then
  log "  PASS table/v1 3x3"
else
  log "  FAIL table/v1 3x3"
  failures=$((failures + 1))
fi

docker rm -f osrm-buildcheck >/dev/null 2>&1 || true
[ "$failures" -eq 0 ] || fail "${failures} probe(s) failed — do not ship this graph."

# --- Stage 5: package -------------------------------------------------------

log "Stage 5 — packaging artifacts for transfer"
cd "$DATA_DIR"
ARTIFACTS=$(ls ${BASENAME}.osrm* 2>/dev/null | tr '\n' ' ')
[ -n "$ARTIFACTS" ] || fail "No .osrm artifacts found"

sha256sum ${BASENAME}.osrm* > "${LOG_DIR}/artifacts.sha256"
ARTIFACT_BYTES=$(du -sb ${BASENAME}.osrm* | awk '{s+=$1} END{print s}')

cat > "${LOG_DIR}/build-manifest.txt" <<EOF
built_at_utc      = $(date -u +%Y-%m-%dT%H:%M:%SZ)
osrm_image        = ${OSRM_IMAGE}
profile           = ${PROFILE}
pbf_url           = ${PBF_URL}
pbf_bytes         = $(stat -c%s "$PBF")
artifact_bytes    = ${ARTIFACT_BYTES}
artifact_gb       = $(awk -v b="$ARTIFACT_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')
artifact_multiple = $(awk -v a="$ARTIFACT_BYTES" -v p="$(stat -c%s "$PBF")" 'BEGIN{printf "%.2f", a/p}')x pbf
peak_ram_extract  = $(peak_from "${LOG_DIR}/mem-extract.log") GiB
peak_ram_partition= $(peak_from "${LOG_DIR}/mem-partition.log") GiB
peak_ram_customize= $(peak_from "${LOG_DIR}/mem-customize.log") GiB
EOF

log "Build manifest:"
cat "${LOG_DIR}/build-manifest.txt"

cat <<EOF

================================================================================
BUILD COMPLETE. Artifacts are in ${DATA_DIR}

Transfer to the production droplet (run from the BUILD droplet):

  rsync -avP --compress-level=1 \\
    ${DATA_DIR}/${BASENAME}.osrm* \\
    root@<PRODUCTION_IP>:/opt/osrm/data/

  scp ${LOG_DIR}/artifacts.sha256 ${LOG_DIR}/build-manifest.txt \\
    root@<PRODUCTION_IP>:/opt/osrm/data/

Then on PRODUCTION, verify and start:

  cd /opt/osrm/data && sha256sum -c artifacts.sha256
  cd /opt/osrm && docker compose -f docker-compose.osrm.yml up -d

THEN DESTROY THIS BUILD DROPLET. Leaving it running costs \$0.50/hr (~\$336/mo).
Copy build-manifest.txt into the deploy log first — those peak-RAM numbers are
the record that sizes every future rebuild.
================================================================================
EOF
