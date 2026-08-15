# Precision Generate: OSRM self-hosting and reliability plan

Status: decision-ready infrastructure pilot; application integration is not yet
enabled.

## Decision

Use one private nationwide U.S. OSRM service as a **road-cost provider for
Precision Generate**, while FirstKnock continues to own property selection,
street-block grouping, route constraints, winner selection, and persistence.

Do not use `router.project-osrm.org` for the beta. Its official policy limits
the demo to reasonable non-commercial use, no more than one request per second,
with no uptime, latency, or map-update guarantee.

The first production pilot should be:

- one Geofabrik U.S. graph covering all 50 states plus DC, including local
  routing inside Alaska and Hawaii;
- MLD preprocessing;
- OSRM 26.7.3, pinned by image digest;
- `foot.lua` by default, matching the product's current walking-route language;
- a 100-coordinate Table limit, including any start/end points;
- an isolated 192–256 GB build worker, a measured 128 GB capacity-pilot server,
  and a second same-artifact replica before nationwide OSRM reliability is
  claimed.

OSRM 26.8.0 was published on the day of this review (2026-08-01). The scaffold
pins the previously released 26.7.3 build so the pilot is reproducible and is
not the first production workload on a same-day release. Upgrade only after the
same regression and shadow gates pass.

## Exact scope

In scope:

- automatic route creation after a completed Precision `FetchJob`;
- the OSRM service, cache, failover, refresh, metrics, and rollback needed by
  that initial generation operation.

Here, "route optimization" means choosing the best property order as part of
that initial Precision Generate job. It does not mean the later Reorder or
saved-route Optimize buttons.

Out of scope for this rollout:

- Canvas planning/deployment;
- CSV and Redfin import routes;
- ZIP explorer, setup wizards, auto-sold routes, merge/split, and filtered-route
  generation;
- rep-only or other legacy route creators without Precision provenance;
- Reorder and saved-route Optimize, including for an already-created Precision
  route;
- geocoding replacement;
- multi-rep VRP, time windows, capacity, breaks, or appointment scheduling.

Those paths remain on the existing continuity behavior unless separately
approved.

### Coverage contract

"Nationwide" means a local Precision job can be generated in any of the 50
states or DC. It does not mean properties from distant markets should be placed
in one matrix. Enforce a market/locality and maximum-diameter guard before the
OSRM call.

Use the single U.S. aggregate rather than state graphs for v1. It preserves
ordinary state-border paths and avoids shard-selection errors. Alaska, Hawaii,
and some pedestrian networks are disconnected graph components, so an
accidental cross-component Table has `null` cells and must be rejected.

The coverage ID `us-50-states-dc` intentionally does not promise U.S.
territories. Puerto Rico, the U.S. Virgin Islands, Guam, American Samoa, and the
Northern Mariana Islands need explicit product approval, suitable extracts,
coverage probes, and backend gateway dispatch. A U.S.-only graph also does not
guarantee a route that crosses Canada or Mexico; use a separately benchmarked
North America graph if that becomes a requirement.

## What the repository does today

The Precision data pull is already a durable backend job. After it completes,
`Home.jsx` fetches the exact job-scoped candidates from
`getRouteCandidatesFromNeon`, then automatically invokes browser-local route
generation. The current optimizer uses street-continuity grouping and
Haversine costs. OSRM is not called anywhere.

The initial Precision save is still browser-controlled and creates routes
independently. The local IndexedDB write can be treated as success even when
the backend create fails. This is the main in-scope reliability risk; simply
replacing a distance function with an HTTP call would not fix it.

Useful existing seams:

- `FetchJob` already has stale-job detection, re-kick, leases/watchdog patterns,
  and a stable Precision job ID.
- `getRouteCandidatesFromNeon` already enforces job/workspace/criteria scope.
- `routeOptimizer.jsx` already accepts `routingContext.distanceBetween` and
  checks exact membership.
- saved Precision routes already carry `metadata.precision_area.job_id` and an
  order fingerprint.

The existing `distanceBetween` seam is fail-open: the shared optimizer falls
back to Haversine when a lookup is missing or throws. Do not use that behavior
to score an OSRM candidate. Validate the complete directed matrix first, then
use a strict accessor/scorer that cannot substitute an aerial distance; any
missing lookup rejects the entire road candidate.

## Precision-only target flow

```text
completed Precision FetchJob
  -> freeze exact property manifest + config + route bounds
  -> create/recover idempotent PrecisionGenerationJob
  -> partition into route-sized street/access groups
  -> build deterministic continuity candidate for every group
  -> matrix cache
  -> private OSRM Table primary, then secondary
  -> build road-cost candidate with FirstKnock's street-sweep solver
  -> score continuity/road candidates on the same complete matrix
  -> exact-once and hard-bound validation
  -> persist missing SavedRoute chunks idempotently
  -> mark job complete and return saved routes
```

Use one backend command for initial Precision Generate. Reorder and saved-route
Optimize remain on their current behavior in this rollout.

OSRM Table is the right service because it supplies directed durations and
distances between known coordinates. Do not use OSRM Trip as the business
optimizer: Trip is an approximate traveling-salesman heuristic and does not
understand FirstKnock's street atomicity, route bounds, or future constraints.
Call OSRM Route only after the final order is selected when road-following map
geometry is needed.

### Frozen optimization objective

The v1 solver must use one explicit, deterministic objective:

1. Hard requirements: exact-once membership, configured start/end bounds, and
   atomic street/access groups.
2. Continuity guardrail: a road candidate may not increase street reentries or
   street transitions relative to the continuity candidate.
3. Primary cost: minimize the sum of directed OSRM `duration` cells, in seconds,
   including applicable start/end legs.
4. Tie-breaks: lower summed OSRM distance in meters, then the stable property-ID
   sequence.

For v1, the existing deterministic continuity partition freezes which homes
belong to each output route. OSRM reorders only within each frozen route group;
it does not move homes between routes. That keeps the comparison meaningful,
limits matrix size, and preserves the current Precision allocation behavior.

Use the duration matrix for block-to-block costs inside the street-sweep solver.
Keep distance for reporting and deterministic tie-breaking; do not blend
seconds, meters, and continuity counts into an undocumented weighted score.
OSRM's reported distance is the length of its fastest profile-weighted path,
not a mathematically shortest-distance path. If shortest walking distance
becomes the product objective, that requires a separately tested profile and a
new baseline rather than changing the comparison silently.

## Reliability contract

### Initial Precision creation

1. Authorize the user and re-load the completed FetchJob server-side.
2. Freeze the exact ordered manifest, Precision criteria, route settings,
   start/end bounds, and an input fingerprint.
3. Generate the existing deterministic continuity candidate first.
4. For each OSRM-eligible route group, get a complete matrix from cache or
   OSRM and generate a road-cost candidate.
5. Score both candidates on that same matrix. Never compare an OSRM total with
   a Haversine total.
6. Select the road candidate only when it is valid and non-worse. Use a stable
   tie-break so replays are deterministic.
7. Verify every frozen property appears exactly once across the full result,
   all route bounds are honored, and no foreign property appears.
8. Save server-side with a generation key. On retry, reconcile and create only
   missing chunks; never duplicate a partially saved job.
9. Mark the job complete only after all result routes are durable.

If OSRM is unavailable or invalid, initial creation still saves the continuity
result and records an explicit degraded reason. OSRM is an optimization
enhancement, not an availability dependency.

### Job and recovery fields

Create a Precision-specific route job rather than broadening every route flow.
It should adopt the existing FetchJob lease/watchdog pattern and store at least:

- tenant/manager/user and Precision FetchJob IDs;
- idempotency key, input fingerprint, and config hash;
- status, stage, lease owner/expiry, heartbeat, attempt count, and last error;
- route profile, graph/data/image version, cache result, matrix size and latency;
- selected candidate, comparable costs, degraded/fallback reason;
- output route IDs, output fingerprint, and timestamps.

Do not store full matrices in SavedRoute metadata. Store them in a bounded,
versioned cache and persist only audit summaries with the route.

## Matrix correctness rules

- Keep matrices directed; walking/driving costs can be asymmetric.
- Start at OSRM's default 100 total coordinates. A 58-door route is within the
  limit only when its start/end points keep the total at or below 100.
- Partition the full Precision candidate pool before requesting matrices. Never
  send thousands of candidates as one quadratic Table request.
- In v1, use OSRM only for route groups within the limit and use continuity for
  larger groups. Add representative street/access-block matrices later if
  101-200-door routes must become road-aware.
- Request `annotations=duration,distance`.
- Send bounded `radiuses` and reject excessive snap distances. The pilot starts
  at 150 m and must tune that value against real Precision pins.
- Validate HTTP status, JSON `code`, dimensions, waypoint counts, finite cells,
  and snap results.
- Reject the entire road candidate when a cell is `null`. Do not silently mix
  OSRM and aerial cells.
- Do not use `fallback_speed`; it invents straight-line estimates inside the
  matrix and hides graph/geocode failures.

The cache key must include ordered normalized coordinates, stable property-ID
mapping (including duplicate-coordinate identities), route bounds, coverage
ID, profile and profile hash, the promoted fingerprint derived from the
artifact-manifest SHA-256 plus pinned runtime-image digest, annotations,
radiuses, and matrix schema version. A merely sorted
coordinate hash or human build label is unsafe because matrix indices, route
direction, and actual graph content matter. Texas-era entries are not compatible
with the nationwide cache family.

## Failure ladder

For one Precision route group:

```text
fresh compatible cache
  -> primary OSRM (1 s connect, 6-7 s total budget)
  -> retry once on a different replica for timeout/network/429/5xx
  -> continuity result for initial Precision Generate
```

"Compatible" means the identical full key and promoted build fingerprint.
Expired entries and matrices from another graph/profile hash are rejected; v1
does not serve stale gateway cache entries.

Do not retry deterministic request errors such as invalid coordinates,
`TooBig`, `NoSegment`, or a malformed manifest. Add a circuit breaker and
bounded global Table concurrency so a struggling OSRM host cannot exhaust
Base44 workers.

Log counts, timings, status/code, cache state, selected candidate, and graph
fingerprint. Do not log raw coordinates or addresses. Disable OSRM request
logging, keep routed at `ERROR` verbosity so warning exception paths cannot
print the request target, use a URI-free gateway format, discard request-scoped
Nginx error logs, and apply the same redaction rule at every external load
balancer or WAF. Use health state, the safe status/timing log, and synthetic
requests for diagnosis; enable verbose logs only against sanitized fixtures.

Keep all provider configuration in backend-only secrets/config. The initial
contract should include a global kill switch, account allowlist, ordered primary
and secondary gateway URLs, bearer token, expected profile/data version and
promoted build fingerprint, total coordinate cap, snap radius, connect timeout,
and total deadline. No OSRM URL,
token, matrix, or raw coordinate list should be sent to or called from the
browser.

## Cheapest practical deployment

The current Geofabrik U.S. input is about 11.2 GB. OSRM publishes no dependable
PBF-to-RAM formula, and the national `foot.lua` graph has not been built here.
Historic OSRM project reports put an older North America car build near 70 GB
peak and serving around 40–50 GB; those figures prove that the old 24 GB Texas
host is unsafe, but they are not a current sizing specification. Walking may
retain more ways than driving.

| Stage | Starting envelope | Advertised cost on 2026-08-01 |
|---|---|---:|
| Capacity pilot | 1 x OVH Game-LE-1, 128 GB ECC, 2 x 960 GB NVMe | $79/month + $79 setup |
| Reliable serving | 2 x Game-LE-1, Hillsboro + Vint Hill | $158/month + $158 setup |
| Currently listed fallback | phoenixNAP `s1.c1.medium`, 128 GB, 2 x 1 TB NVMe | $0.24/hour or $147.87/month each |
| Isolated build | OVH `r3-256` plus 1 TB High-Speed Gen2 block | $1.382/hour; about $33.17/24 h |
| Artifact storage | 200–500 GiB standard object storage | about $1.62–$4.06/month |
| Optional DNS health checks | Route 53 zone plus two external checks | about $2/month plus queries |

OVH's official page also labels the Game-LE-1 offer "Coming Soon." Treat both
Game rows as an unconfirmed budget model until checkout proves that the required
servers can be provisioned in both regions. If they are available, the practical
two-replica budget is roughly $195/month before tax with one 24-hour builder
rental each month, or roughly $295–305/month with weekly rentals. The builder's
1 TB volume is network block storage, not local NVMe; mount it as
`OSRM_DATA_ROOT` and measure throughput and actual build duration before relying
on the 24-hour rental assumption.

phoenixNAP lists Bare Metal Cloud in Phoenix and Ashburn. If the exact
`s1.c1.medium` flavor is in stock in both, two serving nodes are about
$295.74/month. With one 24-hour monthly builder rental, modest artifact storage,
and optional health checks, the fallback envelope is roughly $331–335/month
before traffic and tax. This is not a substitute for checkout and
measured-capacity gates.

Treat 128 GB serving, 256 GB building, and 1 TB builder storage as test
envelopes. Approve a 128 GB node only when measured routed RSS stays at or below
90 GiB under the approved concurrency, cold starts meet the objective, and the
active plus rollback artifacts retain disk headroom. Otherwise move directly
to 192/256 GB nodes; do not use swap as the production capacity plan.

A single host plus continuity fallback makes the Precision user outcome
available, but it is not OSRM HA. Two replicas must be in separate failure
domains, run the identical verified artifact, and be failed over by the backend
rather than relying on DNS alone. Builds run on a temporary third worker, never
on a serving replica.

## Dataset lifecycle

Use Geofabrik's timestamped U.S. extract, currently about 11.2 GB. Start with
monthly full builds while measuring the capacity pilot, then move to weekly
when the pipeline is proven or sooner when map freshness requires it:

1. download a timestamped whole-U.S. PBF and published checksum, rejecting any
   source URL outside Geofabrik's official U.S. aggregate family;
2. record coverage ID, source byte size and hashes, image digest, profile hash,
   dataset base, build ID, artifact-manifest SHA-256, and the combined promoted
   fingerprint;
3. build once into a new immutable directory on an isolated worker;
4. run `osrm-routed --trial`;
5. checksum the graph, upload it to protected artifact storage, download it to
   both replicas, and re-verify every artifact checksum before startup;
6. start a candidate instance and run national health plus Precision
   regressions;
7. shadow traffic, promote one replica, then the other;
8. retain the previous artifact for rollback.

Do not rebuild on a serving node and do not split v1 into state graphs. If a
future memory benchmark forces sharding, use overlapping/buffered shards and
prove that every request fits wholly within one shard before dispatch.

## Rollout gates

### Gate 0: freeze the product contract

- Confirm that Precision routes are walked. If they are driven, switch the
  pilot to a separately built car graph before recording baselines.
- Check in sanitized Precision fixtures across urban, suburban, and rural
  markets, including state-border markets, DC, Anchorage, and Honolulu. Keep a
  Mesquite fixture as one regression. The previously cited
  58-property/14.466-mile result is not present in this repository and used a
  driving service, so it is not a valid walking acceptance baseline.
- Record current continuity order, exact manifest, route bounds, transitions,
  reentries, and deterministic fingerprint.

### Gate 1: private service

- Build the timestamped U.S. graph with the included infrastructure scaffold.
- Verify source and artifact checksums, trial load, auth rejection, bounded snap
  distance, repeated-request cache HIT, timeouts, matching coverage/data/build
  fingerprint, and a finite local Table in every state plus DC.
- Measure build peak, artifact size, runtime RSS, cold start, and 2/10/25/58/100
  coordinate Table latency under bounded concurrency.

### Gate 2: backend shadow mode

- Add the Precision-only route job and OSRM client.
- Generate and score road candidates without changing saved routes.
- Compare exact membership and quality for real allowlisted Precision jobs.
- Prove that a missing/throwing matrix lookup rejects the whole road candidate
  instead of invoking the optimizer's Haversine fallback.
- Keep all non-Precision call sites unchanged.

### Gate 3: allowlisted Precision Create

- Enable winner persistence for internal accounts.
- Require 100% exact-once output, deterministic replay, server-side idempotent
  save recovery, and successful OSRM-off creation.
- Confirm no public-demo requests and no coordinate-bearing logs.

### Gate 4: second replica and broader release

- Add same-build replica failover and a synthetic Precision canary.
- Exercise primary kill, timeout, corrupt/null response, expired-cache rejection,
  restart, and old-build rollback drills.
- Expand the allowlist only after fallback and latency objectives hold for a
  full observation window.

## Proposed service objectives

- 100% of successful Precision jobs preserve exact property membership.
- 100% of repeated identical jobs produce the same output fingerprint.
- Precision Create produces a valid continuity route even with both OSRM
  replicas unavailable.
- No accepted road candidate is worse than its comparison baseline on the same
  complete matrix.
- p95 Table latency below 2 seconds at the approved route size and concurrency;
  backend deadline below 7 seconds per attempt.
- Every promoted national graph passes one local coverage probe in each of the
  50 states plus DC.
- Zero production requests to public OSRM and zero raw coordinate/address logs.

## Sources

- [OSRM README and Docker/MLD guidance](https://github.com/Project-OSRM/osrm-backend)
- [OSRM 26.7.3 release](https://github.com/Project-OSRM/osrm-backend/releases/tag/v26.7.3)
- [Official OSRM container package](https://github.com/Project-OSRM/osrm-backend/pkgs/container/osrm-backend)
- [OSRM Table API](https://github.com/Project-OSRM/osrm-backend/blob/v26.7.3/docs/http.md)
- [OSRM 26.7.3 server limits](https://github.com/Project-OSRM/osrm-backend/blob/v26.7.3/src/tools/routed.cpp)
- [OSRM routed access-logging controls](https://project-osrm.org/docs/v26.4.0/routed)
- [OSRM tool verbosity controls](https://project-osrm.org/docs/v26.6.1/tools)
- [OSRM demo policy](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server)
- [United States Geofabrik extract](https://download.geofabrik.de/north-america/us.html)
- [North America Geofabrik extract](https://download.geofabrik.de/north-america.html)
- [Geofabrik technical notes](https://download.geofabrik.de/technical.html)
- [Historic OSRM North America memory report](https://github.com/Project-OSRM/osrm-backend/issues/5070)
- [OSRM national serving-memory discussion](https://github.com/Project-OSRM/osrm-backend/issues/5689)
- [OVH U.S. dedicated availability and pricing](https://us.ovhcloud.com/bare-metal/regions-availability/)
- [OVH dedicated-server SLA](https://us.ovhcloud.com/legal/sla/dedicated-servers/)
- [OVH public-cloud builder and storage pricing](https://us.ovhcloud.com/public-cloud/prices/)
- [phoenixNAP bare-metal instance pricing](https://phoenixnap.com/bare-metal-cloud/instances)
- [phoenixNAP Ashburn bare-metal availability](https://phoenixnap.com/data-center/ashburn)
- [Route 53 pricing](https://aws.amazon.com/route53/pricing/)
- [OpenStreetMap attribution/license](https://www.openstreetmap.org/copyright)
