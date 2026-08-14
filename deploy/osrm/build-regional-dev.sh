#!/usr/bin/env bash
#
# build-regional-dev.sh — build a small regional graph on a laptop/workstation and
# serve it on :5000, for developing against OSRM without waiting on the full-USA
# build or paying for a droplet.
#
#   ./build-regional-dev.sh                        # North Carolina (default)
#   ./build-regional-dev.sh us/south-carolina
#   ./build-regional-dev.sh us-south               # multi-state, needs ~16 GB RAM
#
# Runs anywhere Docker runs, including Docker Desktop on Windows or macOS. The
# containers are Linux either way; on Windows they run inside WSL2.
#
# North Carolina is ~0.40 GB against 12.08 GB for the full country, so this
# finishes in minutes on a few GB of RAM. It covers both committed FirstKnock
# route exports (Mooresville NC 28115 and Belmont NC 28012), which is enough to
# exercise every code path in osrmClient.js and osrmRoadContext.js.
#
# What it deliberately does NOT do: serve production. No TLS, no auth, no
# watchdog, and coverage stops at the state line. Use docker-compose.osrm.yml
# with the full-USA artifacts for that.
#
set -euo pipefail

REGION="${1:-us/north-carolina}"
DATA_DIR="${DATA_DIR:-$(pwd)/dev-data}"
OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v26.8.0-amd64-debian}"
PORT="${PORT:-5000}"
CONTAINER="osrm-dev"
BASENAME="map"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

command -v docker >/dev/null || { echo "docker is not installed or not on PATH"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and re-run."; exit 1; }

mkdir -p "$DATA_DIR"
PBF="${DATA_DIR}/${BASENAME}.osm.pbf"
URL="https://download.geofabrik.de/north-america/${REGION}-latest.osm.pbf"

if [ -s "$PBF" ]; then
  log "using existing ${PBF} ($(du -h "$PBF" | cut -f1)) — delete it to re-download"
else
  log "downloading ${URL}"
  curl -fL --retry 3 -o "${PBF}.part" "$URL"
  mv "${PBF}.part" "$PBF"
  log "downloaded $(du -h "$PBF" | cut -f1)"
fi

# Docker Desktop's WSL2 backend takes roughly half the host's RAM by default. A
# state-sized extract fits easily; a multi-state region may not, and the failure
# mode is a std::bad_alloc partway through rather than anything obvious.
avail=$(docker run --rm "$OSRM_IMAGE" sh -c "free -g | awk '/^Mem:/{print \$2}'" 2>/dev/null || echo "?")
log "memory visible to Docker: ${avail} GB"

run() {
  log "$1"
  shift
  docker run --rm -t -v "${DATA_DIR}:/data" "$OSRM_IMAGE" "$@"
}

run "osrm-extract"   osrm-extract   -p /opt/car.lua "/data/${BASENAME}.osm.pbf"
run "osrm-partition" osrm-partition "/data/${BASENAME}.osrm"
run "osrm-customize" osrm-customize "/data/${BASENAME}.osrm"

log "artifacts: $(du -sh "$DATA_DIR" | cut -f1)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "${PORT}:5000" -v "${DATA_DIR}:/data" \
  --restart unless-stopped \
  "$OSRM_IMAGE" osrm-routed \
    --algorithm mld \
    --max-table-size 8000 \
    --max-viaroute-size 1000 \
    "/data/${BASENAME}.osrm" >/dev/null

log "waiting for the server"
for i in $(seq 1 40); do
  sleep 3
  if curl -sf "http://127.0.0.1:${PORT}/route/v1/driving/-80.790018,35.593459;-80.788777,35.594156?overview=false" >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 40 ] && { docker logs --tail 40 "$CONTAINER"; echo "server did not start"; exit 1; }
done

echo
for probe in "Mooresville NC 28115:-80.790018,35.593459;-80.788777,35.594156" \
             "Belmont NC 28012:-81.069989,35.195012;-81.065900,35.190189"; do
  name="${probe%%:*}"; coords="${probe#*:}"
  dist=$(curl -s "http://127.0.0.1:${PORT}/route/v1/driving/${coords}?overview=false" \
    | grep -o '"distance":[0-9.]*' | head -1 | cut -d: -f2)
  [ -n "$dist" ] && echo "  PASS  ${name}: ${dist} m by road" || echo "  FAIL  ${name}"
done

# The matrix path is what precision generation actually calls, so prove it works
# at the size the client will actually use.
if curl -s "http://127.0.0.1:${PORT}/table/v1/driving/-80.790018,35.593459;-80.788777,35.594156;-80.792,35.596?annotations=distance,duration" | grep -q '"code":"Ok"'; then
  echo "  PASS  table/v1"
else
  echo "  FAIL  table/v1"
fi

cat <<EOF

Serving ${REGION} on http://localhost:${PORT}

Point the dev app at it — no TLS needed, since a localhost dev server is not an
HTTPS page and mixed-content blocking does not apply:

  VITE_OSRM_BASE_URL=http://localhost:${PORT}
  VITE_OSRM_TOKEN=

Leave VITE_OSRM_TOKEN empty; osrmClient.js omits the Authorization header when it
is unset, and this container has no auth in front of it.

Generate routes from either Charlotte export and check the browser console for
[osrmRoadContext] diagnostics. Anything outside North Carolina will fall back to
Overpass and then to aerial — that is the fallback chain working, not a bug.

Stop it with:   docker rm -f ${CONTAINER}
EOF
