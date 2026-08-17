# Route 1H teardown — why Precision routes read wrong, and the plan to fix them

Measured 2026-08-17 against `Charlotte-Precision-Route-1H-route-export.csv`
(1,000 doors, exported route order). All mileage from OSRM driving, the same
engine and default base URL the product uses. All 999 legs measured, zero chunk
failures.

Full write-up with charts: https://claude.ai/code/artifact/d2a3f8c7-c882-432a-b121-fd3447323477

## The headline

| | |
|---|---|
| Route 1H, real road miles | **628.5** |
| Route 1J (also 1,000 doors, also Charlotte), benchmarked in `route-decomposition-findings.md` | 358.3 |
| Recoverable by reordering alone — no regrouping, slice ends pinned | **&minus;38.4%** whole route (628.5 → 387.4); the eight slices themselves go 551.6 → 310.5 |
| Longest single leg | 27.44 mi, between doors 3.30 mi apart in a straight line |

Leg distribution: p50 0.29, p90 1.46, p95 2.46, p99 4.62, max 27.44.
344 legs over 0.5 mi, 157 over 1 mi, 71 over 2 mi. ~25 h of pure driving at 25 mph.

## The symptom the user reported

Clustering the 1,000 stops into road-connected pockets (single-link @ 0.35 mi)
gives 41 areas. A route that finishes an area before leaving it visits 41 times.
This route visits **79** times — 38 re-entries. At 0.15 mi: 123 re-entries over
255 pockets.

| pocket | entries | stop ranges |
|---|---|---|
| The Peninsula, Cornelius | 6 | 127, 139–159, 161–190, 196–218, 220–241, 244–252 |
| Trolley Run / Coulter | 7 | 26–40, 269–278, 280–296, 309–310, 346–347, 384, 386–502 |
| Glenealy / Bailey | 7 | 24–25, 314–319, 321–322, 330–345, 348–383, 503–603, 605–621 |
| Kannapolis core | 7 | 667, 688–718, 720–731, 734–943, 945–981, 988–991, 994–995 |
| Preston Lake / Nantz | 4 | 86–125, 131–138, 242–243, 253 |

Also: 399 door pairs sit within 0.25 mi of each other but more than 30 stops
apart in the order (worst gap: 372 stops). And 121 legs have road distance
greater than 3× aerial — 210 miles of barrier detour, a third of the route.

## Root causes

### 1. At production size, windows are lat/lng boxes, not road groups

`roadHierarchySequencer.js:523` guards the road-ordered-block path with
`blockPoints.length <= MAX_ROUTE_MATRIX_POINTS` (250, `roadMatrix.js:21`).
A 1,000-door route has ~536 street blocks, so **that branch is unreachable at
production size**. `coarseBlockOrder` and `barrierRepair` both default off, so
every full-size Precision route falls to geometric k-d bisection with
`window_grouping_road_priced: false`.

The file's own comment names the consequence: a box drawn across a river holds
both banks, so the rep crosses once per box however well each box is solved.

### 2. The refinement budget does not cover one complete pass

`HIERARCHY_REFINEMENT_STEP_BUDGET` = 2,000,000, divided by window count
(`roadHierarchySequencer.js:689`) ≈ 182,000 steps for an 11-window route.
`roadAwareStreetSweep.refineBlockOrder` charges `candidate.length` steps per
priced candidate. A 70-block window needs ~7,400 candidates for one full
reversal+relocation pass; the budget affords ~2,500 — measured, exhausted a
third of the way through pass one, with multi-start seeds 2 and 3 getting
nothing.

The non-hierarchical sweep gets `REFINEMENT_STEP_BUDGET` = 16,000,000. Large
routes get the shallowest search.

### 3. The repairs built for this never run on this path

`optimizeRouteRoadMatrix/entry.ts:183` calls `sequenceRoadHierarchy` directly
with default options — no `barrierRepair`, no `coarseBlockOrder`, no portfolio.
`roadDecompositionPortfolio` is imported only by `partitionRouteTerritories`,
and `FROZEN_BASELINE_PORTFOLIO` filters it to the single mandatory baseline.
`barrierWindowRepair` is benchmarked in our own findings at 502.8 vs 518.3 mi
on Route 1I with longest leg 11.9 → 6.0, and it is not reachable from generation
or from Optimize.

## The isolating experiment

Three windows re-solved against the same OSRM matrix, street blocks kept atomic
exactly as the sweep does, entry and exit doors pinned so the result drops back
into the route without changing any leg outside it. Only the search budget varies.

| window | shipped | production step budget | converged |
|---|---|---|---|
| 126–253 · The Peninsula (128 doors) | 67.8 | 36.0 | **31.1** |
| 386–502 · Cornelius (117) | 42.4 | 20.2 | **18.0** |
| 688–800 · Kannapolis (113) | 57.6 | 33.7 | **26.8** |

Two conclusions:

- **Street-block atomicity is not the defect.** Block-atomic search beat an
  unconstrained door-level search on every window. The invariant helps.
- The shipped→budget gap is decomposition; the budget→converged gap is search
  depth. Both are large.

Reorder only, per-slice −31% to −52%. The eight slices go 551.6 → 310.5 mi.

**310.5 is not a route total and not a floor.** It sums the eight slices only; the
seven legs *between* slices are untouched and carry 76.9 mi between them, one of
which is the 27.4-mi lake crossing. The honest whole-route comparison is
**628.5 → 387.4 (−38.4%, 241 mi saved)**. And 387.4 is what one local search
reached, not a proven minimum — do not quote either number as a theoretical floor.
That is a floor — no door changed neighbourhood, no slice boundary moved, and
the eight boundary legs (including the 27-mile crossing) were untouched.

## Plan

### Phase 0 — Read 1H's stored routing block first (1–2 days, no solver changes)

Check `decomposition` (expect `geometric_windows`),
`window_grouping_road_priced` (expect false), `road_aware_degraded`,
`optimality_status`, `solver_runtime_ms` against the frontend's 45s
`ROAD_MATRIX_DEADLINE_MS`, and `validated_road_miles` against the 628.5 measured
here.

The 27-mile leg is consistent with **both** "geometric windows" and "road pass
timed out and the aerial continuity order shipped". The fixes differ. Settle it
from the record before touching the solver.

### Phase 1 — Two-layer scorecard before fix (3–5 days, offline, runs on exported CSVs)

Replace "optimized" as one number with **two** vectors. The goal is not the
mathematically shortest route; it is the route an experienced rep would choose to
drive. Those overlap but are not identical, and they need separate measurement.

**Layer 1 — road efficiency**

- verified road miles (keep)
- **barrier straddle miles** — legs where road > 3× aerial. 1H: 121 legs, 210 mi
- **leg tail** — p95/p99/max, count > 1 mi
- whether decomposition was road-priced; whether the search converged

**Layer 2 — human route logic**

| invariant | metric | 1H | target |
|---|---|---|---|
| finish an area before leaving it | pocket re-entries | **38** | 0–2 |
| stay long enough to work it | median uninterrupted run | **2 doors** | > 15 |
| don't touch and run | visits of a single door | **32** | 0 |
| don't pass a house you'll return for | deferred neighbours (<0.25 mi, >30 stops) | **399** | < 50 |
| keep moving in one direction | direction reversals >120° | **30.2%** | < 12% |
| sweep the territory, don't wander it | progression efficiency | **14.1%** | > 45% |
| one entrance, one visit | single-entry branch re-entries | see Phase 4 | 0 |

Progression efficiency projects every stop onto the territory's principal axis;
a clean sweep scores 100%. 1H scores 14.1% — it travels **7.1× the territory's
own length** along that axis. Median uninterrupted run of 2 doors means the route
almost never settles anywhere; it is in near-constant transit.

All Layer 2 numbers above were computed from the export alone, so this ships with
no product change. Targets are starting positions for the rep panel to argue with.

Exit: one command scores any export on both layers; 1H, 1I, 1J, Salisbury have
committed baselines.

### Phase 2 — Turn on the optimizer we already paid for (1–2 weeks)

One at a time, each benchmarked against Phase 1 on all four fixtures.

- **2a** Raise the hierarchy step budget so at least one complete refinement pass
  per window is guaranteed, scaled from block count rather than a flat constant.
  Pure CPU, no new road requests. Measured win: the budget→converged column above.
- **2b** Make road-grouped windows reachable above 250 blocks. `coarseBlockOrder`
  already does this. It lost on 1J (386 vs 358 mi) — but 1J took the geometric path
  too, so that was two grouping strategies compared with a starved solver.
  **Re-run after 2a lands**, on the scorecard, before deciding.
- **2c** Run the decomposition portfolio on generation with `barrierRepair` in the
  set. Selection is already "lowest verified mileage wins, baseline always
  competes", so it cannot produce a worse route — only a slower generation.

**Layer 2 is a guardrail here, not an objective.** These changes optimize
distance, and distance optimization demonstrably does not fix behaviour on its
own: converged search cut the peninsula window 42% and moved heading reversals
only 41 → 40. So Layer 2 is reported on every candidate and must not regress — a
decomposition that shaves four miles while adding six pocket re-entries loses.
Without that rule Phase 2 hands Phase 4 a shorter route that reads just as wrong.

Exit: regenerated 1H under 400 road miles with < 10 pocket re-entries,
1I/1J/Salisbury do not regress on any Layer 1 metric, and no fixture regresses on
any Layer 2 metric.

### Phase 3 — Give the solve room to finish (1–2 weeks, parallel with Phase 2)

Phase 2 spends CPU. Current ceiling is `ROAD_MATRIX_DEADLINE_MS` = 45s on an
interactive request, with the documented solve already ~38s.

- Move the 1,000-door solve to the existing background job pattern.
- **Never ship an unmeasured order silently** — surface it in the UI, not only in
  a metadata field.
- Put `roadCostCache` on the generation path so portfolio candidates share the
  street-block matrix.

Exit: a 1,000-door generation can spend three minutes of solver time; a failed
road pass is visible to the manager.

### Phase 4 — Dead-end branches as first-class routing units (3–4 weeks)

The hard invariant: **single-entry branch → enter once → reach the deepest useful
point → service continuously toward the exit → never re-enter.**

Fourth because Phases 2–3 recover most of the mileage without it. Indispensable
because they do not recover the behaviour.

**Detection method — already tested.** Real OSRM road matrix over stops 126–253
(128 doors), doors linked where the drive between them is under a threshold, then
Tarjan articulation points:

| link threshold | cut vertices | largest area behind one gate | times entered |
|---|---|---|---|
| 0.20 mi | 14 | 11 doors · Summer Place / Springwinds / Players Ridge | **3×** |
| 0.30 mi | 10 | 34 doors · Berkley Commons / Middletown / Northport | **6×** |
| 0.40 mi | 12 | 39 doors · Rainbow Cir / Lagoona / Bethelwood | **7×** |

The signal is unambiguous at every threshold. **Caveat:** a proximity graph over
doors is not a road network — it fragments into 24–53 pieces, so the threshold is
doing work the topology should do. Production should build the graph from actual
road ways. The bet holds; the construction needs building properly.

- **Make those components atomic**, as street blocks are today. Street-block
  atomicity measured as a help, not a constraint — same idea one level up.
- **Traverse farthest-first**: drive to the deepest leaf, work back to the neck,
  servicing on the way out. On a single-entrance branch this is provably at least
  as good as any yo-yo order.
- **Constraint, not penalty.** Re-entering a single-entry branch should be illegal
  in the search space rather than merely expensive in the objective — otherwise a
  large enough mileage saving buys its way past the rule, which is exactly the
  trade a human refuses. Prove it as a constraint first; soften only if a fixture
  shows it costing real miles for no behavioural gain.

Exit: The Peninsula, Cornelius entered once. Branch re-entries zero across all
four fixtures, every other Layer 2 metric improves, Layer 1 mileage not regressed
against Phase 2.

### Phase 5 — Reps are the acceptance gate (ongoing from Phase 2)

- 3–5 reps who know their territories. Two unlabelled orderings of the same doors,
  ask which they'd run. Track win rate.
- "This route is wrong here" control in the app capturing the stop range. Each
  report becomes a candidate fixture.
- Any rep-reported defect the scorecard scored clean is a missing metric. Add it,
  re-score every fixture.

Exit: reps prefer the generated order over their own re-ordering in a clear
majority of blind comparisons, on territories never tuned against.

## Critical path

Diagnose 1H → build the two-layer scorecard → restore production-scale road
optimization → remove the 45-second ceiling → add branch/peninsula intelligence
→ rep acceptance testing.

Layer 1 first, but **Layer 2 measured and guarded from the moment the scorecard
exists.**

## Start here

Phase 0, then Phase 2a. Reading 1H's routing block takes an hour and decides
whether this is a decomposition problem or a timeout problem. Raising the step
budget is a small, reversible, benchmarked change that must land before the 2b
comparison means anything.

Resist building Phase 4 first. It is the most interesting problem and it is
genuinely needed, but on the evidence it is worth a fraction of turning the
existing optimizer back on, and it is far easier to evaluate once routes are not
twice as long as they should be.

Insist on the converse: Layer 2 gets measured in Phase 1 even though it is not
optimized until Phase 4. If Phase 2 is graded on mileage alone it will pass with
a route 250 miles shorter that still enters The Peninsula six times — and the
whole budget will have gone into proving the wrong thing.

## What this does not establish

- Production runtime of a converged search at 1,000 doors.
- Whether 1H's road pass ran or timed out — Phase 0 answers that from the record.
- That any of this transfers off Lake Norman. `route-decomposition-findings.md`
  already warns decomposition results do not transfer between cities; that is the
  argument for the Phase 1 fixture set and for re-running 2b rather than trusting
  its earlier result.
