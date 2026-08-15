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
proxy. The unit ceiling is **derived, not a constant**: 240 is a property of the
current `MAX_ROUTE_MATRIX_POINTS = 250` implementation and its anchor overhead,
not of OSRM. If the matrix budget later moves to 500, the partitioner must
follow automatically.

- primary: `MAX_BLOCK_TIER_ROUTING_UNITS = MAX_ROUTE_MATRIX_POINTS - anchorCount`
  (240 at today's values), so every generated route road-optimizes at block tier
  or better. `roadMatrixTiers.js` already computes exactly this as `blockBudget`;
  it must be the single source, replacing the hardcoded `ROUTING_UNIT_BUDGET`.
- 240 is the **initial value**, tunable in one place. Stage 4's public-OSRM
  benchmark may move it to 180 or 300; that must not require redesigning
  anything.
- proxy target: **1,000 homes = the product cap** (hard). 800-1,200 is the
  *balance tolerance band*, not a partition budget — see the defect note below.
- hard ceiling: whichever binds first; the partitioner cuts on the unit budget

## Staged implementation

1. **Shared hierarchy module** (`base44/shared/`): homes -> street blocks ->
   road-topology pockets, reusing `buildStreetBlocks` and the existing pocket
   detection so generation, splitting and optimization share one definition.
2. **Unit-budget partitioner**: replace the door-only target in
   `chunkStreetBlocks` with a dual budget (units + homes), keep pockets atomic,
   add balance and compactness to the cut score.
3. **Validate every partition against the routing-work budget, enqueue
   partitions through a bounded OSRM dispatcher, optimize each partition, and
   require explicit road-optimization success before reporting a route as
   road-optimized** — replacing the aerial `FALLBACK_ROUTING_METADATA` for
   generated routes. Stage 2 now owns this.
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

**Defect found in review (must fix in Stage 2):** the dense row says 14 routes at
1,143 homes each, which is *above* the 1,000-home product cap. Cause:
`routingUnitWorkload` defaults `doorBudget = 1200` — the balance band's upper
edge used as if it were the cap. With the correct 1,000 cap, dense becomes **16
routes at ~1,000 homes**. Sparse is unaffected (units bind at 23). The band and
the cap are two different things and must not share one number.

**Simulation caveat:** these rows ran with no road network, so units == street
blocks. That is fine for sizing arithmetic but is *not* the partitioner's input
contract. The real partitioner takes **homes + road graph + drawn territory
polygon** together; without the polygon there are no boundary nodes, so a road
that merely stops at the edge of the fetched data reads as a dead end and gets
protected as a fake pocket, which would block legitimate cuts along the
territory edge.

This is the point of the whole exercise: the same 16,000 homes need 14 routes
dense and 23 sparse, decided by road complexity rather than a fixed homes/route
number.

Also done: `base44/shared/streetTopologyCore.js` — the pocket definition
extracted verbatim from `canvasStreetTopology.js` (bridge finding, 2-core
reduction, terminal-enclave selection, chain decomposition, id helpers). Both
`canvasStreetTopology.js` and `routingUnits.js` now import it, so the two
competing detectors are gone. This also fixed a real defect: `routingUnits`
treated every nested bridge as its own pocket and double-counted them.

16,000-home simulation, before vs after the extraction (cul-de-sacs actually
built in the fixture: 163 dense / 762 sparse):

| density | pockets before | pockets after | protected units | model ms before -> after |
|---|---|---|---|---|
| dense | 326 | **163** | 163 | 2,239 -> 2,348 |
| sparse | 1,524 | **762** | 762 | 46,920 -> **14,907** |

Pocket counts now match the fixture exactly. Route counts unchanged (14 dense /
23 sparse); exact-once holds. Suites: `canvas-street-topology` 15/15,
`canvas-street-territory-planner` 16/16, `routing-units` 7/7,
`routing-unit-parity` 3/3 (no route drift), `test-failure-baseline-gate` 4/4.

Remaining in Stage 1: rewire `generateRoutesBackend`, the splitters and
`routeRoadContext` onto this model (acceptance criterion 3), which is where
generated route output can change and needs its own verification. The known
divergence is the cost-only road context, which lacks the gap split and so
groups 4 and 6 blocks where the frontend sweep does not; `routing-unit-parity`
pins that divergence today and must show it closing.

Verification per stage: exact-once invariant, `test/route-scale-benchmark.mjs`
re-run, plus the existing `route-street-sweep`, `road-matrix-tiers`,
`generate-routes-backend-continuity`, and `route-zone-partition` suites.

---

# Stage 2 plan: shared partitioner + OSRM dispatch budget

Status: plan only. No behavior changed. Do not start coding until this section is
approved.

## Intended outcome

A territory of any size never reaches the optimizer as one oversized route. One
shared partitioner decides how many routes a territory becomes and guarantees
that **every** partition it emits is inside the road-matrix budget, so no route
can silently degrade to aerial. The partitioner owns route size; OSRM does not.

Stage 2 deliberately absorbs the OSRM request budget (previously staged as 3).
The fan-out is the thing that creates the load, so shipping the partitioner
without the budget would turn one oversized request into 16-20 throttled ones,
and per-route throttling fails back to aerial — the exact silent failure this
work exists to remove.

## Non-goals

- Self-hosting OSRM (still Stage 5) and benchmarking public OSRM capacity
  (Stage 4). Stage 2 needs a *configured, enforced* budget, not a measured one.
- Raising the product-level 1,000-home cap.
- Changing map display, filtering, or which homes qualify for a territory.
- Rewriting the solver or the tier planner. Tiers stay as the safety net.

## The two budgets

| budget | value | owner | meaning |
|---|---|---|---|
| `MAX_HOMES_PER_ROUTE` | 1,000 | product | operator-facing cap. Hard. |
| `BALANCE_TOLERANCE_BAND` | 800-1,200 | product | acceptable spread *between* routes; never a partition budget |
| `MAX_BLOCK_TIER_ROUTING_UNITS` | derived (240 today) | technical | `MAX_ROUTE_MATRIX_POINTS - anchorCount`; keeps every route at block tier or better |

Both budgets live in `base44/shared/`, and the unit budget is imported from the
tier planner rather than restated. A partition is valid only if it satisfies
both. Whichever binds first decides the route count — `routingUnitWorkload`
already computes this and reports `bindingBudget`; Stage 2 consumes it rather
than re-deriving, after its `doorBudget` default is corrected to 1,000.

## Decision rule

```
homes > MAX_HOMES_PER_ROUTE            -> partition
routing units > MAX_ROUTING_UNITS_PER_ROUTE -> partition
partition still over budget            -> subdivide that partition (bounded)
still over budget after the bound      -> fail loudly to the manager
otherwise                              -> optimize
```

## Objective precedence (fixed, not negotiable per-call)

1. **Validity** — inside both budgets. A partition that cannot be road-optimized
   is not a partition we ship.
2. **Topology** — do not break pockets or cut mid-street unless validity forces
   it.
3. **Compactness** — contiguous, geographically sensible shape.
4. **Balance** — roughly equal homes, a soft objective inside the tolerance
   band, never a constraint that can force an invalid, pocket-breaking, or
   non-contiguous cut.

Good shape beats perfectly equal numbers. An unbalanced pair of routes is a minor
annoyance; an invalid route is a silent aerial fallback, which is worse. 900 vs
1,100 is an acceptable outcome.

First implementation keeps compactness and balance **simple** — a contiguity
check plus a spread tolerance. Sophisticated cut scoring is a later refinement,
not a Stage 2 requirement.

## Pocket atomicity, stated honestly

- A protected pocket that **fits** a route is never split.
- A pocket **larger** than the budget cannot be kept whole. It is split at its
  internal street boundaries (never mid-street), and the resulting routes are
  stamped with an override marker naming the pocket.
- The marker is required, not optional: it is what makes a rep-visible re-entry
  traceable to a cause instead of looking like an optimizer bug.

"Never split a pocket" as an absolute is unimplementable — the existing chunker
already falls back to street segments in this case — so the rule is written to
match reality rather than being discovered in production.

## Where it lives

`base44/shared/territoryPartitioner.js` — one partitioner, consumed by
`generateRoutesBackend`, the split/rerun paths, and any frontend reorder path.
No consumer keeps a private version. Stage 1 collapsed two pocket definitions
into one; adding a second partitioner one layer up would recreate that problem.

Hard requirements on it:

- **Partitions routing units, not doors.** Slicing a door list and hoping blocks
  survive is what cuts a street in half. Input is the Stage 1 unit model.
- **Deterministic on stable keys.** The parity and baseline gates only work
  because ordering is reproducible; any order-dependent seeding makes them
  worthless.
- **Input contract is homes + road graph + drawn territory polygon**, never homes
  alone. Without boundary nodes, a road window that merely ends at the fetch edge
  reads as a dead end and gets protected as a fake pocket, which would block
  legitimate cuts along the territory edge. Canvas already passes its polygon;
  the partitioner must too. Road topology must be loaded *before* the final cuts
  are made, not after.
- **Whole-set exactly-once.** Asserted across the entire partition set, not per
  route. Today `assertExactRouteMembership` guards a single generation call, so
  18 individually-clean routes can still have lost a home between them.

## OSRM dispatcher (separate concern from the partitioner)

Clean separation: **the partitioner decides _what_ gets optimized; the dispatcher
decides _when and how fast_ it is sent.** These are two problems and get two
modules.

The word "parallel-safe" is removed from the plan. 20 valid routes x several
matrix requests each, fired at once, is simply the old failure relocated: the
public server throttles, requests time out, and routes fall back individually.

One shared dispatcher in `base44/shared/` fronts every road-matrix call and owns:

- max concurrent requests (default low; parallelism is a tuning knob, not the
  default)
- max requests per time period
- timeout per request
- retry policy (bounded)
- per-route outcome: succeeded / failed
- per-route tier actually used (door / block / cluster)

## Explicit road-optimization status — the non-negotiable part

Today's dangerous behavior is: OSRM fails -> local optimizer runs -> UI says
"Optimized!". That ends here.

- Road matrix succeeded -> route reports **road-optimized**, with the tier used.
- Road matrix failed, timed out, or was refused -> route reports **road
  optimization unavailable**. A local result may still be produced, but it is
  labelled as local in both the UI and the persisted metadata.
- No code path may label a local/aerial result as road-optimized. This is the
  single most important acceptance criterion in Stage 2.

## The tier ladder stays

The existing door/block/cluster tiers in `roadMatrixTiers.js` are **not
removed**. The partitioner's job is to make cluster tier *rare*, not to assume it
can never happen. Deleting a working safety net on the strength of an assumption
is not an improvement.

## Target architecture

```
USER DRAWS TERRITORY
        |
LOAD HOMES + ROAD TOPOLOGY + POLYGON
        |
SHARED ROUTING-UNIT MODEL          (Stage 1, done)
        |
PARTITIONER                        max homes | max routing units |
        |                          pocket protection | compactness | balance
VALIDATE WHOLE TERRITORY           no missing / no duplicate homes |
        |                          every route under both budgets
OSRM DISPATCH QUEUE                limited concurrency, rate, timeout, retry
        |
ROAD OPTIMIZATION                  tier ladder retained as safety net
        |
EXPLICIT SUCCESS / FAILURE         never "optimized" for a local result
        |
COMBINE ROUTES -> SHOW USER
```

OSRM is no longer responsible for figuring out how to handle 16,000 homes. The
partitioner handles that first.

## Risks

- Route output changes for existing generation paths — the parity/baseline
  fixtures are the tripwire and must be re-captured deliberately, not silently.
- 240 units comes from synthetic-metric benchmarks; real public-OSRM latency may
  move it. Derived from the matrix budget in one place, so retuning is a value
  change, not a redesign.
- The bounded-subdivision loop is where an infinite retry could hide. The depth
  cap and the loud failure path both need their own tests.
- Correcting `doorBudget` 1200 -> 1000 changes route counts on any existing
  caller of `routingUnitWorkload`. Currently only tests and the simulation
  consume it, so the blast radius is small — but it must be verified, not
  assumed.

## Verification

- New: partitioner unit tests (dual budget, precedence, pocket fits/does not
  fit + override marker, determinism across shuffled input, whole-set
  exactly-once, bounded subdivision, loud failure).
- New: dispatcher tests (concurrency cap respected, rate limit honored, timeout
  and bounded retry, exhaustion reports honestly, per-route tier recorded, and a
  dedicated test that **no path can label a local result as road-optimized**).
- Existing, must stay green: `routing-units`, `routing-unit-parity`,
  `route-street-sweep`, `road-matrix-tiers`,
  `generate-routes-backend-continuity`, `route-zone-partition`,
  `route-road-context`, `canvas-street-topology`,
  `canvas-street-territory-planner`, `test-failure-baseline-gate`.
- 16,000-home simulation re-run with the corrected 1,000-home cap and a road
  network present: expect **16 dense / 23 sparse**, every partition inside both
  budgets, exactly-once across the whole set.