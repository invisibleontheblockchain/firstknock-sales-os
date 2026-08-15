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

## Built: the replacement membership engine

Shipped as a parallel engine. The production split path is untouched until the
live benchmark says the new one wins, which is the point of building it this way.

| file | role |
|---|---|
| `base44/shared/splitAtoms.js` | granularity: homes → blocks → units, atom size driven by K |
| `base44/shared/routeTerritoryPartitioner.js` | seeds → capacitated road growth → boundary refinement → portfolio → measured selection |
| `base44/shared/splitQualityMetrics.js` | the split report (balance, fragmentation, interleaving, cost) |
| `base44/functions/partitionRouteTerritories/entry.ts` | live endpoint; returns memberships only, writes nothing |
| `test/route-territory-partitioner.test.mjs` | 8 offline invariant/behaviour tests |
| `scripts/route-split-benchmark.mjs` | old vs new, same frozen solver, same measurement |

### How it decides membership

1. **Atoms.** Indivisible pieces sized to the requested workload: an atom may hold
   at most half a route's target. At K=2 whole units/pockets stay intact; at
   K=100 the same code descends to blocks and, only where forced, door groups.
   Blocks come from `buildStreetBlocks` and pockets from `buildRoutingUnits` —
   neither definition is restated. There is no "never split a pocket" rule.
2. **Road costs.** One rectangular atom-to-atom OSRM table in real miles,
   chunked to the 250-destination ceiling.
3. **Seeds.** K seeds by farthest-point sampling on *road* distance. Geometry
   appears only as the deterministic first seed.
4. **Growth.** Capacitated: an atom joins the route it is road-nearest to that
   still has room; `loadPenalty` sets how hard balance competes with proximity.
5. **Refinement.** Whole-pocket moves first, then block moves and swaps across
   road-adjacent boundaries. A move survives only if K holds, balance holds,
   exact-once holds and the road-priced objective strictly drops.
6. **Portfolio.** Four partitions compete (`topology_first`,
   `balanced_road_growth`, `peripheral_seeds`, `balance_led`).
7. **Selection.** Finalists are sequenced by the **frozen** solver
   (`sequenceBestDecomposition`, baseline decomposition, unmodified) and measured
   independently by `measureRoadPath`. **Lowest combined verified road miles wins.**

### Two objectives, deliberately

Selection is measured miles. Refinement uses a surrogate — a road-priced tour
over each route's atom representatives — because K solver runs + K measurements
per candidate move is unaffordable. The surrogate is built from the same OSRM
miles (never straight-line), is used only to *choose* moves, and never reports a
mileage or picks the winner. Atoms are indivisible, so intra-atom cost is
identical in every partition and correctly excluded.

Pleasant consequence: atom count scales with K, so region sizes stay small at
high K and atom counts stay small at low K — the refinement cost is self-limiting
at both ends rather than exploding in the middle.

### Balance

Tolerance is **6% of N/K**, a band rather than the old exact floor/ceil equality
(the equality that forced cuts through subdivisions). Capacity is a preference,
not a wall: if no route can take an atom within tolerance it is placed in its
road-nearest route anyway and the relaxation is counted — losing a home is worse
than an uneven day. The report publishes achieved deviation so the tolerance is
benchmarkable.

### Hard invariants (checked on the way out, not assumed)

N in = N out · every home exactly once · exactly K non-empty routes · frozen
solver per route · selection on independently verified mileage · unresolved road
cost ⇒ `ok: false`, never a partial split.

### Verification run

- `test/route-territory-partitioner.test.mjs` — 8/8 pass: exact-once and exact K
  at K=2/3/5/10/20/50; a river barrier separates territories instead of being
  sliced; zero street-block fragmentation where sweep-slicing fragments; balance
  inside tolerance; granularity scales with K; three distinct fail-closed paths;
  winner is the measured winner.
- Full suite: **919 tests → 893 pass / 26 fail**, the same 26 pre-existing
  failures as the Precision freeze gate, **0 new**.
- `npm run validate:backend` → 92 functions validated. ESLint clean on all new files.

Note on SPLIT-03: an earlier version asserted the new engine beats sweep-slicing
on mileage in the synthetic fixture. It tied (15.788 vs 15.787) because that
fixture's sweep happens to align with the river, so slicing it is already near
optimal. The assertion was corrected to what the fake engine can honestly prove —
never materially worse, and zero block fragmentation. **Mileage superiority is a
claim about real geography and belongs to the live benchmark, not to a fixture
built to produce it.**

## Also shipped (UI only)

`SplitRouteModal` now opens on **Number of routes** (first button, default mode,
remembered as `fk_split_route_count`); Maximum homes is the second option. No
planning or write logic changed — the modal still calls the old planner.

## Not done yet

- **Live benchmark run.** `scripts/route-split-benchmark.mjs <fixture> 2,3,5,10,20,50,100`
  needs a live OSRM run against the 1,000-home fixtures (Route 1I/1J, then
  unrelated territories) to produce the old-vs-new table.
- **Production cutover.** `SplitRouteModal`/`splitRouteUtils` still use the sweep
  slicer; switching them to `partitionRouteTerritories` should follow the
  benchmark evidence, not precede it.
- **Progress UI** for the longer generation at high K, and persisting the split
  report onto created routes.