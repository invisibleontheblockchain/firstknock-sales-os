# Route Splitter — Step 1 audit (no production membership change)

Separate project from the frozen Precision solver. This is the read-only trace of
what the shipped splitter actually does, why the attached Route 1J split looks
interleaved, and what the general K-way partitioner has to replace. **No
membership logic was changed by this audit.**

## What ships today

Path: `SplitRouteModal` → `buildOptimizedSplitPlan()` in
`src/components/routes/splitRouteUtils.jsx`.

```
saved route manifest
  → normalizeStopsForPlanning()        validate: >=2 homes, all hydrated, all geocoded
  → createRouteContinuityContext()     street-segment + access-group keys (aerial context)
  → optimizeRouteByStreetSweep()       ONE global 1..N street-sweep order
  → rotateSweepForVariant()            "New areas" = rotate that 1-D order
  → chooseBalancedGroupSizes()         DP over floor/ceil group sizes
  → contiguous slices of the sweep     group k = order[offset .. offset+size]
  → optimizeRouteByStreetSweep() per group
```

### Answers to the audit questions

| question | current answer |
|---|---|
| what units are split | **individual homes, in one global 1-D sequence position**. Not blocks, not pockets. |
| objective for membership | **none.** Membership is whatever falls inside a contiguous index window of the sweep. The only search is *where to put the ±1 home*, via `splitBoundaryPenalty`. |
| how K is enforced | exactly: every route gets `floor(N/K)` or `ceil(N/K)` homes (`chooseBalancedGroupSizes`). |
| how target homes/route affects membership | `max_homes` mode just converts to `K = ceil(N/value)` and then hard-fails if any group exceeds the max. Same slicing. |
| does road distance participate | **no.** The split is aerial: street sweep + `haversineDistanceMiles`. `calculateRouteDistanceMiles` in the preview is aerial too. The frozen road optimizer, the road matrix, `roadCostCache`, and `measureRoadPath` are **never called** by the splitter. |
| can street blocks be divided | **yes.** A block is only *discouraged*: same `streetSegmentKey` across the cut costs 1,000, same canonical street 500. Balance always wins — the DP can only move a boundary by one home, so a block that straddles a mandated cut index gets cut. |
| can single-entry pockets be divided | **yes**, same way. Same `accessGroupKey` across a cut costs 10,000 — a preference, not a constraint, and it is only ever consulted at the K-1 mandated cut indices. |
| does it understand lakes / highways / access barriers | **no.** `accessGroupKey` comes from `createRouteContinuityContext` (aerial/street-name derived), not from measured road connectivity. Nothing measures a bridge detour, a limited-access crossing, or a real access-point count. |
| balancing counts or geography | **counts, strictly.** Geography enters only as tie-breaking at the cut, plus the intra-group re-sweep afterwards. |

### Root cause of the interleaving in the screenshot

A street sweep is a **one-dimensional serpentine** across the whole territory. It
is an excellent *driving order* for one rep and a poor *territory boundary*:
consecutive indices can be far apart whenever the sweep turns or jumps between
neighbourhoods. Cutting that ribbon into K contiguous pieces therefore produces
long thin strings rather than compact areas, and any pocket the ribbon enters
more than once — a peninsula entered, left, and re-entered later in the sweep —
lands in **two or more different groups**. That is precisely the failure the user
flagged, and it is structural, not a tuning problem. This is the
"do not split the optimized 1,000-stop sequence into K chunks" case.

`rotateSweepForVariant` ("New areas") only rotates the same ribbon, so every
variant inherits the same defect.

Consequence: no metric currently exists for blocks split, pockets split, shared
areas, interleaving, or **total road miles across the K routes** — the split is
never evaluated against the routes it produces.

## What the replacement has to be

A **scale-aware road-topology K-way partitioner**, K anywhere from 2 to the
product maximum, where granularity follows the requested workload:

```
homes → street blocks → pockets / access regions → road-coherent regions
                                   ↓ choose the depth that reaches K
                        K memberships (exact-once)
                                   ↓
              frozen road optimizer INDEPENDENTLY per route
                                   ↓
        independent road measurement → sum miles → candidate score
```

- Splitter owns **membership**; the frozen solver owns **sequence**. No mixing.
- Topology is a **preference hierarchy, not a prohibition** — at K=2 think in
  regions, at K=100 descend to blocks/doors. No peninsula-specific rule.
- Primary objective: **total independently verified road miles across all K
  routes.** Constraints: exact K, exact-once, balance inside a researched
  tolerance, minimal fragmentation / pocket splitting / interleaving.
- Candidate portfolio + boundary refinement (move/swap a block or a whole
  pocket between neighbours, re-optimize only affected routes, accept only on
  measured mileage decrease), reusing `roadCostCache` so competing candidates
  never repay for the same road truth.
- Required scale proof on the same 1,000-home territory: **K = 2, 3, 5, 10, 20,
  50, 100.**
- Route 1J is the diagnostic fixture: count the peninsula's homes, blocks, real
  access points, how many routes enter it today, the extra miles those entries
  cost, then test the counterfactual of one owner + rebalance outside.

## Shipped in this pass (UI only)

`SplitRouteModal` now opens on **Number of routes** (first button, default mode,
remembered separately as `fk_split_route_count`); Maximum homes remains as the
second option. No planning, membership, or write logic changed.

## Not started yet

Everything above the "UI only" line — audit findings, no code. Next step is the
Route 1J diagnostic measurement (peninsula access points + current cross-route
entries + mileage cost), before any production membership change.