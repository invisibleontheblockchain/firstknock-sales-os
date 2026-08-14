#!/bin/sh
#
# watchdog.sh — primary server-side reliability mechanism for the single-droplet
# routing stack. With no load balancer and no second node, this is what keeps
# software-level faults measured in seconds instead of hours.
#
# Escalation ladder (each tier only fires when the tier below has failed to fix it):
#   T1  3 consecutive probe failures (~90s)  -> docker restart osrm
#   T2  2 T1 restarts within 15 min          -> full stack down/up + clear stale locks
#   T3  3 T2 events within 60 min            -> reboot droplet via DigitalOcean API
#   T4  probe failing continuously > 15 min  -> alert only; clients are on local fallback
#
# Mounted read-only from the host and run by /bin/sh. Deliberately NOT an inline
# compose command: `$FAILURES` and `$((...))` inside a compose `command:` block are
# interpolated by compose before the shell sees them.
#
set -u

PROBE_INTERVAL=30
T1_THRESHOLD=3
T2_WINDOW=900        # 15 min
T3_WINDOW=3600       # 60 min
T4_WINDOW=900        # 15 min of continuous failure
DISK_ALERT_GB="${DISK_ALERT_GB:-15}"

# Two real FirstKnock service areas, one per committed route export. Probing both
# means the watchdog also catches a graph that came up but does not cover a market
# we actually sell in.
ROUTE_PROBE_A="-80.790018,35.593459;-80.788777,35.594156"   # Mooresville NC 28115
ROUTE_PROBE_B="-81.069989,35.195012;-81.065900,35.190189"   # Belmont NC 28012
# 3x3 table probe: precision generation uses /table, not /route. A server that
# answers /route but fails /table is broken for our actual workload.
TABLE_PROBE="-80.790018,35.593459;-80.788777,35.594156;-80.792000,35.596000"

OSRM="http://osrm:5000"
VROOM="http://vroom:3000"

failures=0
t1_times=""
t2_times=""
first_failure_at=0
alerted_t4=0
last_disk_alert=0

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

alert() {
  level="$1"; shift
  msg="$*"
  log "ALERT[$level] $msg"
  [ -z "${ALERT_WEBHOOK:-}" ] && return 0
  wget -q -O /dev/null --header='Content-Type: application/json' \
    --post-data "{\"text\":\"[FirstKnock OSRM][$level] $msg\"}" \
    "$ALERT_WEBHOOK" 2>/dev/null || log "webhook delivery failed"
}

# Keep only timestamps inside `window` seconds, then count them.
prune_and_count() {
  list="$1"; window="$2"; now="$3"
  kept=""; count=0
  for ts in $list; do
    if [ $((now - ts)) -lt "$window" ]; then
      kept="$kept $ts"; count=$((count + 1))
    fi
  done
  echo "$count|$kept"
}

probe() {
  wget -q -T 10 -O - "$1" 2>/dev/null | grep -q "$2"
}

check_health() {
  probe "${OSRM}/route/v1/driving/${ROUTE_PROBE_A}?overview=false" '"code":"Ok"' || return 1
  probe "${OSRM}/route/v1/driving/${ROUTE_PROBE_B}?overview=false" '"code":"Ok"' || return 2
  probe "${OSRM}/table/v1/driving/${TABLE_PROBE}?annotations=duration" '"code":"Ok"' || return 3
  return 0
}

check_vroom() {
  wget -q -T 15 -O /dev/null --header='Content-Type: application/json' \
    --post-data '{"vehicles":[{"id":1,"start":[-80.790018,35.593459]}],"jobs":[{"id":1,"location":[-80.788777,35.594156]}]}' \
    "$VROOM" 2>/dev/null
}

check_disk() {
  now="$1"
  # Alert at most hourly so a full disk does not become a full log.
  [ $((now - last_disk_alert)) -lt 3600 ] && return 0
  free_gb=$(df -BG /data 2>/dev/null | tail -1 | awk '{print $4}' | tr -dc '0-9')
  [ -z "$free_gb" ] && return 0
  if [ "$free_gb" -lt "$DISK_ALERT_GB" ]; then
    alert T5 "Free disk on /data is ${free_gb} GB (threshold ${DISK_ALERT_GB} GB). A refresh will fail. This is Phase 2 trigger T-5."
    last_disk_alert="$now"
  fi
}

reboot_droplet() {
  if [ -z "${DO_API_TOKEN:-}" ] || [ -z "${DO_DROPLET_ID:-}" ]; then
    alert T3 "Would reboot the droplet, but DO_API_TOKEN/DO_DROPLET_ID are not set. Manual intervention required."
    return 1
  fi
  alert T3 "Rebooting droplet ${DO_DROPLET_ID} via DigitalOcean API."
  wget -q -O /dev/null --header="Authorization: Bearer ${DO_API_TOKEN}" \
    --header='Content-Type: application/json' --post-data '{"type":"reboot"}' \
    "https://api.digitalocean.com/v2/droplets/${DO_DROPLET_ID}/actions" 2>/dev/null
}

log "watchdog started — probing every ${PROBE_INTERVAL}s, T1 after ${T1_THRESHOLD} consecutive failures"

while true; do
  sleep "$PROBE_INTERVAL"
  now=$(date +%s)
  check_disk "$now"

  if check_health; then
    code=0
  else
    code=$?
  fi

  if [ "$code" -eq 0 ]; then
    if [ "$failures" -gt 0 ]; then
      log "recovered after ${failures} consecutive failure(s)"
      [ "$alerted_t4" -eq 1 ] && alert RECOVERY "Routing is healthy again after a sustained outage."
    fi
    failures=0; first_failure_at=0; alerted_t4=0

    # OSRM-healthy / VROOM-dead is a silent state: routes work, optimization
    # quietly falls back to client-side ordering. Detect it explicitly.
    if ! check_vroom; then
      log "VROOM probe failed while OSRM is healthy — restarting vroom"
      docker restart vroom >/dev/null 2>&1 && alert T1 "VROOM was unresponsive and has been restarted (OSRM unaffected)."
    fi
    continue
  fi

  failures=$((failures + 1))
  [ "$first_failure_at" -eq 0 ] && first_failure_at="$now"
  log "probe failed (mode ${code}), consecutive=${failures}"

  # T4 — sustained total outage. Nothing left to restart; say so loudly.
  if [ $((now - first_failure_at)) -ge "$T4_WINDOW" ] && [ "$alerted_t4" -eq 0 ]; then
    alert T4 "Routing has been down for over $((T4_WINDOW / 60)) minutes. Clients are running on the client-side fallback optimizer. Restore from the artifact copy or rebuild."
    alerted_t4=1
  fi

  [ "$failures" -lt "$T1_THRESHOLD" ] && continue

  # --- T1 ---
  parsed=$(prune_and_count "$t1_times" "$T2_WINDOW" "$now")
  t1_count=$(echo "$parsed" | cut -d'|' -f1)
  t1_times="$(echo "$parsed" | cut -d'|' -f2-) $now"
  t1_count=$((t1_count + 1))

  if [ "$t1_count" -lt 2 ]; then
    log "T1 — restarting osrm container"
    docker restart osrm >/dev/null 2>&1
    alert T1 "OSRM failed ${failures} consecutive probes; container restarted."
    failures=0
    continue
  fi

  # --- T2 --- second T1 inside 15 min: the container restart is not fixing it.
  parsed=$(prune_and_count "$t2_times" "$T3_WINDOW" "$now")
  t2_count=$(echo "$parsed" | cut -d'|' -f1)
  t2_times="$(echo "$parsed" | cut -d'|' -f2-) $now"
  t2_count=$((t2_count + 1))

  if [ "$t2_count" -lt 3 ]; then
    log "T2 — full stack restart"
    alert T2 "Second OSRM restart within 15 minutes; cycling the full stack."
    docker restart osrm vroom >/dev/null 2>&1
    failures=0
    t1_times=""
    continue
  fi

  # --- T3 --- three stack restarts in an hour: the box itself is the problem.
  log "T3 — escalating to droplet reboot"
  reboot_droplet
  failures=0
  t1_times=""
  t2_times=""
done
