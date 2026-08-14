# Full-USA OSRM + VROOM — deployment

Self-hosted road routing for every FirstKnock precision generation path, anywhere
in the United States. This directory is the executable form of the OSRM/VROOM
production runbook, with the runbook's open questions resolved against live
sources on 2026-08-14.

---

## Do this first

The graph build is the long pole — roughly 5–8 hours. Start it before anything
else; the app-side work can be done while it runs.

```bash
doctl compute droplet create osrm-build --size m-8vcpu-64gb --image docker-20-04 --region nyc3 --ssh-keys <FINGERPRINT> --wait
```

Then on the build droplet, inside `tmux`:

```bash
fallocate -l 32G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
git clone https://github.com/invisibleontheblockchain/firstknock-sales-os.git && cd firstknock-sales-os/deploy/osrm && ./build-usa-graph.sh
```

The script is idempotent per stage. A dropped SSH session costs you nothing;
completed stages are skipped on re-run.

---

## What was verified, and what changed

Every figure below was checked against a live source on 2026-08-14. The runbook
carried these as `ASSUMPTION — reverify at execution time`; they are no longer
assumptions.

| Item | Runbook said | Verified | Source |
|---|---|---|---|
| `us-latest.osm.pbf` | 13–15 GB | **12.08 GB** (12,081,275,559 bytes, built 2026-08-13) | Geofabrik `Content-Length` |
| Build RAM multiplier | unresolved: 3–5x **or** 12–20x | **3–5x holds. 12–20x does not.** | 9 GB North America built on 64 GB + 10 GB swap |
| Artifact disk | 4.5x or 6x pbf (55–90 GB) | **~5.2x → ~63 GB** | same build produced 47 GB from 9 GB |
| Serving RAM | untested guess | **~24 GB at 9 GB pbf → ~32 GB at 12 GB** | measured runtime figure |
| Build SKU | m-8vcpu-64gb or m-16vcpu-128gb | **m-8vcpu-64gb is enough** ($0.50/hr) | follows from the above |
| Block storage price | GAP — "do not invent" | **$0.10/GiB/month** | DigitalOcean volumes pricing |
| Build disk | 300–350 GB, maybe a volume | **200 GB included NVMe is enough.** No volume needed. | 12 GB pbf + 63 GB artifacts + slack |
| `vroom-docker` maintained? | inferred from release cadence | **Yes** — last commit 2026-03-17, tracks VROOM v1.15.0 | GitHub API |
| Per-rebuild cost | $12–48 | **~$4–6** (8h at $0.50/hr) | verified build SKU + duration |

**Net effect on cost:** the build is cheaper and simpler than planned. Steady
state is unchanged at $168/mo for `m-4vcpu-32gb`. The honest number to plan
against is **~$170–175/month all-in**, not $185–220.

### The 32 GB serving figure deserves attention

Measured serving RAM scales to ~32 GB for the current pbf, and the selected
production SKU has exactly 32 GB — shared with VROOM, Caddy, the watchdog and the
OS. That is not margin, it is a coin flip.

Two ways out, in order of preference:

1. **Drop `vroom-frontend`** (already omitted from the compose file here) and cap
   OSRM at 26 GB (`deploy.resources.limits.memory`, already set). Then measure.
2. **Step up to `m-8vcpu-64gb`** at $336/mo if step 5 of the validation suite
   shows sustained swapping.

Do not skip step 7 of `validate.sh`, and watch the watchdog's swap alert in the
first week. This is the one number that could still force a resize.

---

## Three problems the runbook did not catch

**1. Mixed content would have broken this in every browser.**
The runbook says to point the app at `http://<droplet-ip>:5000`. The FirstKnock
app is served over HTTPS, and browsers block plaintext subresource requests from
an HTTPS page. The endpoint would have tested perfectly with `curl` on the
droplet and failed for every real user. Caddy terminates TLS on a real hostname
here, which is why `OSRM_DOMAIN` is required rather than optional.

Related: the runbook's advice to restrict port 5000 with a cloud firewall scoped
to "the app's egress addresses" does not apply — these requests originate in
users' browsers, which have no fixed egress. Auth is a bearer token at Caddy
instead. That token ships to the browser, so it is obfuscation, not a secret; if
abuse appears, move the calls behind a base44 backend function.

**2. `--max-table-size` defaults to 100.**
Never mentioned in the runbook. Left at the default, every matrix request over
100 coordinates returns `TooBig` and precision generation silently falls back to
straight-line distance — the exact failure the deployment exists to fix. Set to
8000 in the compose file.

**3. The Docker Hub image is five years stale.**
`osrm/osrm-backend:latest` was last pushed 2021-07-20 (v5.25.0). The runbook's
commands use it. Publishing moved to GHCR, where tags are arch+distro qualified:
`ghcr.io/project-osrm/osrm-backend:v26.8.0-amd64-debian`. The serving binary must
also match the one that built the artifacts, or `osrm-routed` refuses to load them.

One more, for the app side: POST body support for `/table` was merged upstream on
2026-08-13 — one day after v26.8.0 shipped. It is **not** in the pinned release,
so the runbook's "send coordinates in the POST body" is not available. Coordinates
ride in the URL, which is why `MAX_COORDS_PER_REQUEST` is 200.

---

## Files

| File | Role |
|---|---|
| `build-usa-graph.sh` | Build droplet: download, extract, partition, customize, verify, package. Idempotent per stage; records peak RSS per stage. |
| `docker-compose.osrm.yml` | Production stack: osrm + vroom + caddy + watchdog. |
| `Caddyfile` | TLS, bearer auth, CORS. |
| `watchdog.sh` | T1→T4 escalation ladder. Mounted read-only, not an inline compose command. |
| `vroom-conf/config.yml` | VROOM → OSRM over HTTP. |
| `.env.example` | Copy to `.env` and fill in. |
| `validate.sh` | Pre-cutover suite. Run before pointing the app at the endpoint. |

---

## Production deploy

```bash
# On the production droplet (m-4vcpu-32gb)
mkdir -p /opt/osrm/data && cd /opt/osrm
git clone https://github.com/invisibleontheblockchain/firstknock-sales-os.git /tmp/fk
cp -r /tmp/fk/deploy/osrm/* /opt/osrm/
cp .env.example .env && vi .env          # OSRM_DOMAIN + OSRM_TOKEN are required

# Point DNS at this droplet BEFORE starting — Caddy needs it to get a certificate.
# Artifacts arrive here from the build droplet:
#   rsync -avP /opt/osrm/data/map.osrm* root@<PROD_IP>:/opt/osrm/data/
cd /opt/osrm/data && sha256sum -c artifacts.sha256
cd /opt/osrm && docker compose -f docker-compose.osrm.yml up -d

./validate.sh https://osrm.firstknock.online "$OSRM_TOKEN"
```

First boot takes a few minutes: OSRM faults ~63 GB of MLD data off NVMe, which is
why the healthcheck has a 180-second `start_period`.

Then set in the app environment and redeploy:

```
VITE_OSRM_BASE_URL=https://osrm.firstknock.online
VITE_OSRM_TOKEN=<the same token>
```

**Destroy the build droplet** once `validate.sh` is green. It costs $0.50/hr and
does nothing further. Copy `build-logs/build-manifest.txt` off it first — those
peak-RAM numbers size every future rebuild.

---

## How the app uses it

`src/services/osrmClient.js` is transport only. Strategy lives in
`src/components/logic/osrmRoadContext.js`, which produces the same frozen context
shape the optimizer already consumes, so `routeOptimizer.jsx` is untouched: it
keeps calling the synchronous `routingContext.distanceBetween()` and now gets road
distances instead of straight lines.

### Why tiling rather than one big matrix

A 25,000-door pull is thousands of distinct street blocks. A dense matrix over
them is tens of millions of cells — unshippable. Chunking only the source rows
(as an earlier draft did) still repeats every coordinate in every URL and blows
the URL limit.

Instead: doors collapse onto street blocks, blocks are k-d tiled into compact
groups of ≤180, each tile gets one exact dense road matrix, and cross-tile hops
use aerial distance scaled by the detour factor **measured between those two
tiles**. A river with one bridge inflates crossings over it automatically, with no
hand-tuned constant.

Measured against the two committed route exports:

| | Route 1 (Mooresville) | Route 2 (Belmont) |
|---|---|---|
| doors | 9,089 | 6,562 |
| street blocks | 5,354 | 3,814 |
| OSRM requests | **33** | **33** |
| cells fetched | 897k | 456k |
| dense equivalent | 28.7M (32x) | 14.5M (32x) |
| tile diameter | 6.6 mi median | 4.5 mi median |

Distances inside a ~6-mile tile — more than a full day's territory — are exact
road distances. Only longer hops are approximated.

### Coverage of the five precision generation paths

Before this change, four of the five ran on straight-line distance.

| Path | Entry point | Before | Now |
|---|---|---|---|
| Re-optimize a route | `lib/reoptimizeRouteAction.js` | Overpass road graph | OSRM, Overpass fallback |
| Large route generation | `logic/largeRouteOptimizer.js` | aerial | OSRM (prefetched, passed into the worker) |
| Territory setup wizard | `manager/TerritorySetupWizard.jsx` | aerial | OSRM |
| Route merge | `routes/ActiveRoutesTab.jsx` | aerial | OSRM |
| Route merge / split | `routes/RouteCommandPanel.jsx` | aerial | OSRM |

The large-route path runs inside a Web Worker with a synchronous distance hook,
so the matrix is fetched on the main thread and passed across as plain data
(`createOsrmContextPayload` → `hydrateOsrmRoadContext`). That is what makes the
worker road-aware without an async rewrite of the optimizer.

### Fallback chain

OSRM → Overpass road graph → aerial. Each tier degrades quietly and records why
in `routingContext.diagnostics`. Nothing throws; a routing outage makes routes
worse, never broken.

Watch `diagnostics.exactLookupShare` (the fraction of distance queries answered
from a real road matrix) and `getOsrmCounters().fallbackRate`. A rising fallback
rate is the earliest signal the single droplet is saturating, and it is the
measurement Phase 2 trigger T-3 is defined against.

---

## Refresh

Quarterly is the recommended cadence while pre-breakeven — about $4–6 per rebuild
on the verified build SKU.

Artifacts are ~63 GB on a 100 GB volume, leaving ~37 GB free. That is not enough
for both an old and a new graph, so a refresh is a short maintenance window, not a
blue/green swap. Now that block storage is priced at $0.10/GiB/month, a 100 GiB
volume at $10/month converts that window into a symlink swap with no downtime.
That is the cheapest available upgrade to this architecture.

Run `build-usa-graph.sh` on a fresh temporary droplet, validate there, then
transfer. Never rebuild in place on the production droplet.
