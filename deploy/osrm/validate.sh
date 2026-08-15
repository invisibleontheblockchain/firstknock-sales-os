#!/usr/bin/env bash
#
# validate.sh — pre-cutover validation suite. Run this against the live endpoint
# before pointing the app at it.
#
#   ./validate.sh https://osrm.firstknock.online "$OSRM_TOKEN"
#   ./validate.sh http://127.0.0.1:5000          # on the droplet, before Caddy
#
# Exits non-zero if anything fails. Nothing here is a smoke test for its own
# sake: every probe corresponds to a way the deployment has actually been
# observed to fail, or to a claim in the runbook that needs to be true.
#
set -uo pipefail

BASE="${1:-http://127.0.0.1:5000}"
TOKEN="${2:-}"
AUTH=()
[ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer ${TOKEN}")

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

get() { curl -sf --max-time 90 "${AUTH[@]}" "$1" 2>/dev/null; }

# Real coordinates from the two committed route exports.
R1_A="-80.790018,35.593459"   # 111 Fox Glove Dr, Mooresville NC 28115
R1_B="-80.788777,35.594156"   # 146 Cole Dr,      Mooresville NC 28115
R2_A="-81.069989,35.195012"   # 146 McCullough Dr, Belmont NC 28012
R2_B="-81.065900,35.190189"   # 114 Carrigan Dr,   Belmont NC 28012

head_ "1. Reachability and TLS"
if [[ "$BASE" == https://* ]]; then
  if curl -sf -o /dev/null --max-time 20 "${BASE}/route/v1/driving/${R1_A};${R1_B}?overview=false" "${AUTH[@]}"; then
    ok "HTTPS endpoint reachable with a valid certificate"
  else
    bad "HTTPS endpoint unreachable or certificate invalid — the app CANNOT call this from a browser"
  fi
  if [ -n "$TOKEN" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BASE}/route/v1/driving/${R1_A};${R1_B}?overview=false")
    [ "$code" = "401" ] && ok "unauthenticated request correctly rejected (401)" \
                        || bad "unauthenticated request returned ${code}, expected 401 — endpoint is open to the internet"
  fi
else
  echo "  SKIP  plain HTTP base; browsers will block this from an HTTPS app page."
  echo "        Fine for on-droplet checks, never as the value of VITE_OSRM_BASE_URL."
fi

head_ "2. Both service areas are present in the graph"
for pair in "Route 1 Mooresville:${R1_A};${R1_B}" "Route 2 Belmont:${R2_A};${R2_B}"; do
  name="${pair%%:*}"; coords="${pair#*:}"
  body=$(get "${BASE}/route/v1/driving/${coords}?overview=false")
  dist=$(printf '%s' "$body" | grep -o '"distance":[0-9.]*' | head -1 | cut -d: -f2)
  if printf '%s' "$body" | grep -q '"code":"Ok"' && [ -n "$dist" ]; then
    ok "${name}: ${dist} m by road"
  else
    bad "${name}: no route returned"
  fi
done

head_ "3. National coverage (not a regional extract)"
for pair in "Seattle:-122.335167,47.608013;-122.200676,47.610378" \
            "Austin:-97.743061,30.267153;-97.669891,30.294088" \
            "Miami:-80.191790,25.761680;-80.130045,25.790654" \
            "LA->NYC:-118.243683,34.052235;-74.005974,40.712776"; do
  name="${pair%%:*}"; coords="${pair#*:}"
  if get "${BASE}/route/v1/driving/${coords}?overview=false" | grep -q '"code":"Ok"'; then
    ok "${name}"
  else
    bad "${name} — graph does not cover the full USA"
  fi
done

head_ "4. Matrix path (what precision generation actually calls)"
build_coords() {  # count, base_lng, base_lat
  local n="$1" lng="$2" lat="$3" out="" i
  for ((i=0; i<n; i++)); do
    out+="$(awk -v b="$lng" -v i="$i" 'BEGIN{printf "%.6f", b + (i%12)*0.004}'),"
    out+="$(awk -v b="$lat" -v i="$i" 'BEGIN{printf "%.6f", b + int(i/12)*0.004}');"
  done
  printf '%s' "${out%;}"
}

for n in 3 50 150 200; do
  coords=$(build_coords "$n" -80.790018 35.593459)
  t0=$(date +%s%N)
  body=$(get "${BASE}/table/v1/driving/${coords}?annotations=distance,duration")
  t1=$(date +%s%N)
  ms=$(( (t1 - t0) / 1000000 ))
  if printf '%s' "$body" | grep -q '"code":"Ok"'; then
    ok "${n}x${n} table ($((n*n)) cells) in ${ms} ms"
    [ "$n" = "200" ] && [ "$ms" -gt 60000 ] && \
      bad "200x200 exceeded the client's 60s /table timeout — raise TABLE_TIMEOUT_MS or lower MAX_TILE_SIZE"
  else
    code=$(printf '%s' "$body" | grep -o '"code":"[^"]*"' | head -1 | cut -d'"' -f4)
    bad "${n}x${n} table failed (code=${code:-none})"
    [ "$code" = "TooBig" ] && echo "        --max-table-size is too low; the compose file sets 8000"
  fi
done

head_ "5. Sources/destinations split (how the client chunks)"
coords=$(build_coords 100 -80.790018 35.593459)
if get "${BASE}/table/v1/driving/${coords}?sources=0;1;2;3;4&destinations=5;6;7;8;9&annotations=distance" \
   | grep -q '"code":"Ok"'; then
  ok "sources/destinations subsetting works"
else
  bad "sources/destinations subsetting failed"
fi

head_ "6. VROOM"
if [[ "$BASE" == https://* ]]; then VROOM_URL="${BASE}/vroom"; else VROOM_URL="http://127.0.0.1:3000"; fi
vbody=$(curl -sf --max-time 30 "${AUTH[@]}" -X POST "$VROOM_URL" -H 'Content-Type: application/json' \
  -d "{\"vehicles\":[{\"id\":1,\"start\":[${R1_A/,/,}]}],\"jobs\":[{\"id\":1,\"location\":[${R1_B/,/,}]},{\"id\":2,\"location\":[${R2_A/,/,}]}]}" 2>/dev/null)
if printf '%s' "$vbody" | grep -q '"code":0'; then
  ok "VROOM solved a 2-job problem through OSRM"
else
  bad "VROOM did not return a solution (optimization falls back to client-side ordering)"
fi

head_ "7. CORS preflight"
if [[ "$BASE" == https://* ]]; then
  acao=$(curl -s -o /dev/null -D - --max-time 20 -X OPTIONS "${BASE}/route/v1/driving/${R1_A};${R1_B}" \
    -H "Origin: https://firstknock.online" -H "Access-Control-Request-Method: GET" 2>/dev/null \
    | grep -i '^access-control-allow-origin' | tr -d '\r')
  [ -n "$acao" ] && ok "preflight returns ${acao}" \
                 || bad "no Access-Control-Allow-Origin — browser requests will be blocked"
else
  echo "  SKIP  (no proxy in front of a plain-HTTP base)"
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo "Do not cut traffic over until these are green."; exit 1; }
echo "Green. Set VITE_OSRM_BASE_URL=${BASE} and VITE_OSRM_TOKEN, then redeploy the app."
