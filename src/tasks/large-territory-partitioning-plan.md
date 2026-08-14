# Large-territory partitioning + routing-work ceiling

Status: plan + benchmark evidence. No behavior changed yet.

Goal: a drawn territory of any size (16,000 homes) becomes a set of balanced,
geographically coherent, fully road-optimized routes — never one oversized
optimization request, and never a silent aerial fallback.

Non-goals: raising `MAX_TIERED_ROUTE_DOORS` on its own; self-hosting OSRM;
changing how homes are displayed on the map (display stays viewport-culled and
independent of routing).

## What already exists (verified)

- **No door x door matrix above 250 doors.** `planTieredRoadMatrix` caps the
  matrix at `MAX_ROUTE_MATRIX_POINTS = 250` coordinates: door tier <= 250 doors,
  then block tier (one representative per street block), then cluster tier
  (k-d bisection of blocks). 16,000 doors is refused outright, so a
  256-million-pair request is already impossible.
- **Generation already partitions on structure, not arbitrary slices of N.**
  `generateRoutesBackend` builds canonical street blocks -> subdivision access
  blocks -> globally ordered blocks -> `chunkStreetBlocks`, which scores cut
  points against `houses_per_route` and penalizes cutting mid-street (0.45) or
  mid-subdivision (0.18). `chunk_boundary_priority` is
  `['subdivision_access', 'street', 'door']`.
- **Exact-once invariant** is asserted on every generated partition.

## Gaps against the target architecture

1. **Level 3 is a label, not topology.** Access blocks come from provider
   `subdivision_name`. Cul-de-sacs, dead ends, single-entrance subdivisions and
   bridge-connected pockets are detected only in the client-side road context
   (`routeRoadContext` / `canvasStreetTopology`), which generation never calls.
   A pocket with no subdivision label can therefore be cut across a boundary.
2. **Generated routes are never road-optimized.** Generation is explicitly
   aerial (`road_network_used: false`). Road optimization happens only when a
   user later presses Optimize on one route. Step 6 of the target ("optimize
   each chunk") does not happen automatically.
3. **Partition shape is corridor-based.** Chunks are contiguous runs of a 1-D
   nearest-neighbour block order. Usually contiguous, but compactness and
   balance are not objectives, and there is no cross-territory validation for
   gaps, overlaps, or bad boundaries.
4. **Oversized existing routes refuse instead of partitioning.** Above 2,500
   doors `tryRoadMatrixOptimize` returns null and the local path runs while the
   toast still says optimized.
5. **Default target is 100 homes/route**, not the 800-1,000 discussed.

## Benchmark (measured, this repo)

`node test/route-scale-benchmark.mjs [doors] [density]`. Synthetic 1.3x
haversine metric (O(1) per lookup, same as a matrix lookup), so solver timings
are representative and OSRM counts come from the real tier planner.
`requestMs` = sweep run twice (distance + duration), as the backend does.

| doors | density | blocks | tier | matrix pts | OSRM reqs | sweep ms | request ms | heap MB |
|---|---|---|---|---|---|---|---|---|
| 250 | dense | 18 | door | 250 | 36 | 40 | 80 | 0.1 |
| 500 | dense | 36 | block | 37 | 1 | 165 | 330 | 0.9 |
| 750 | dense | 54 | block | 55 | 4 | 591 | 1182 | 2.2 |
| 1000 | dense | 72 | block | 73 | 4 | 983 | 1966 | 3.1 |
| 1250 | dense | 90 | block | 91 | 4 | 1027 | 2054 | 1.8 |
| 1500 | dense | 108 | block | 109 | 9 | 1054 | 2108 | -0.2 |
| 250 | sparse | 84 | door | 250 | 36 | 2088 | 4176 | 0.0 |
| 500 | sparse | 167 | block | 168 | 16 | 1017 | 2034 | -0.4 |
| 750 | sparse | 250 | **cluster** | 250 | 36 | 997 | 1994 | 1.9 |
| 1000 | sparse | 334 | **cluster** | 250 | 36 | 1004 | 2008 | -2.2 |
| 1250 | sparse | 417 | **cluster** | 250 | 36 | 1036 | 2072 | 2.6 |
| 1500 | sparse | 500 | **cluster** | 250 | 36 | 1028 | 2056 | 9.4 |

All rows passed exact-once. Findings:

- **Doors are the wrong ceiling.** 1,500 dense doors = 108 blocks and stays
  block tier; 750 sparse doors = 250 blocks and already degrades to cluster
  tier, where whole neighbourhoods collapse to one matrix point.
- **Solver cost is bounded by the step budget, not door count** (~1s per sweep
  once the budget binds), so latency is not what limits route size.
- **Precision is what limits route size**: the meaningful ceiling is
  `blocks + anchors <= 250`, i.e. stay in block tier.
- OSRM requests stay <= 36 in every row — the matrix is not the bottleneck.

## Recommended ceiling

Express the budget in routing units, with a door figure as the operator-facing
proxy:

- primary: **<= 240 street blocks** per generated route (240 + anchors <= 250,
  so every generated route can be road-optimized at block tier or better)
- proxy target: **~1,000 homes**, preferred band 800-1,200
- hard ceiling: whichever binds first; the partitioner cuts on the unit budget

## Staged implementation

1. **Shared hierarchy module** (`base44/shared/`): homes -> street blocks ->
   road-topology pockets, reusing `buildStreetBlocks` and the existing pocket
   detection so generation, splitting and optimization share one definition.
2. **Unit-budget partitioner**: replace the door-only target in
   `chunkStreetBlocks` with a dual budget (units + homes), keep pockets atomic,
   add balance and compactness to the cut score.
3. **Optimize each partition** with the road matrix after partitioning
   (per-chunk, parallel-safe), replacing the aerial `FALLBACK_ROUTING_METADATA`
   for generated routes.
4. **Replace the >2,500 refusal** with automatic partitioning of an oversized
   existing route, and make the toast/metadata state the tier honestly.
5. **Cross-territory validation**: no gaps, no overlaps, contiguous neighbours,
   report boundary cost.

## Stage 1 progress

Done: `base44/shared/routingUnits.js` — the single authority for
homes -> street blocks -> road-topology pockets. Runtime-agnostic ESM (no Deno,
no browser, no network) so both backend functions and `src` can consume it.
Blocks delegate to `buildStreetBlocks` so a block is never redefined. Pockets
come from bridge topology: every bridge edge is a candidate throat and the
smaller side is the pocket, which covers cul-de-sacs, dead-end stubs,
single-entrance subdivisions and bridge enclaves under one rule. Pocket ids are
FNV-1a hashes of the claimed edge set, so they are stable across runs and
independent of input order. A protected pocket collapses to ONE routing unit.
Tests: `test/routing-units.test.mjs` (7/7).

16,000-home simulation (`buildRoutingUnits` + `routingUnitWorkload`, no road
network so units == street blocks):

| density | units | model ms | routes by units | routes by doors | routes | binding | avg doors/route | avg units/route |
|---|---|---|---|---|---|---|---|---|
| dense | 1,143 | 125 | 5 | 14 | 14 | doors | 1,143 | 82 |
| sparse | 5,334 | 73 | 23 | 14 | 23 | routing units | 696 | 232 |

This is the point of the whole exercise: the same 16,000 homes need 14 routes
dense and 23 sparse, decided by road complexity rather than a fixed homes/route
number.

Remaining in Stage 1: rewire `generateRoutesBackend`, the splitters and
`routeRoadContext` onto this model (acceptance criterion 3), which is where
generated route output can change and needs its own verification.

Verification per stage: exact-once invariant, `test/route-scale-benchmark.mjs`
re-run, plus the existing `route-street-sweep`, `road-matrix-tiers`,
`generate-routes-backend-continuity`, and `route-zone-partition` suites.