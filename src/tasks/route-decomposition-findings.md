# Decomposition granularity benchmark — Route 1J (1,000 doors, Charlotte)

Same optimizer for every row. Only the WINDOW SIZE (how many doors are solved
together) changes. Miles are independently measured with real road routing on the
finished order, so no row is self-reported.

| window doors | groups | road miles | runtime | OSRM requests | unique road pairs | longest leg | p95 leg |
|---|---|---|---|---|---|---|---|
| 34  | 44 | 373.011 | 55.4s | 341 | — | 6.855 | 1.272 |
| 46  | 33 | 365.160 | 47.5s | 278 | — | 6.874 | 1.316 |
| 60  | 24 | 358.335 | 41.3s | 251 | 280,610 | 6.874 | 1.240 |
| **69** | **21** | **354.563** | **39.2s** | **242** | 255,701 | 6.874 | 1.204 |
| 80  | 18 | 358.848 | 36.7s | 230 | 236,572 | 6.874 | 1.155 |
| 92 (production baseline) | 14 | 358.285 | ~38s | ~230 | — | 6.874 | ~1.2 |
| 138 | 10 | 360.963 | 31.9s | 197 | 200,510 | 6.874 | 1.203 |
| coarse road-ordered windows @92 | 11 | 386.031 | 38.6s | 252 | 260,822 | 10.499 | 1.316 |

## What the curve says

1. **Finer is NOT better.** Below ~60 doors per window mileage climbs sharply
   (34 doors costs +18.4 miles over the best) while runtime grows 40%. Small
   windows starve the exact solver of the context it needs.
2. **The landscape is jagged, not a smooth bowl.** 69 wins at 354.563, yet its
   immediate neighbours 60 (358.335) and 80 (358.848) are both WORSE than the
   92-door production baseline (358.285). A 3.7-mile win sitting between two
   losses is not a tunable optimum — it is the decomposition happening to cut
   this particular territory on better block boundaries.
3. **Therefore 69 must not become a global constant.** It is frozen as the Route
   1J *fixture champion*. A constant chosen from one city would be a coin flip on
   the next one, and the jaggedness is exactly the evidence for that.
4. **Ordering the whole territory's street blocks on roads before cutting windows
   lost badly** (386.0 mi, longest leg 10.5 mi). Road-coherent grouping at full
   route size sprawls — the same result the earlier road-access grouping
   experiment produced (417.9 mi). Rejected automatically by the portfolio.

## Architecture question (A / B / C)

The Route 1J evidence points at **C — a small bounded portfolio whose candidates
compete on independently measured miles** — and rules out A:

- **A (one global window size)** is contradicted by point 2: the winner's own
  neighbours lose to the baseline, so no single value is defensibly "correct".
- **B (adaptive from route structure)** is not yet supportable. Every candidate
  here shares one longest leg (6.874 mi) and near-identical p95, so no cheap
  structural signal in this fixture predicts which window size wins. Adaptive
  selection needs a predictor, and we have no evidence one exists yet.
- **C** needs no predictor: it runs 2–4 bounded candidates and keeps the one that
  measures shortest, with production decomposition always competing so the result
  can never be knowingly worse than today.

**Cost of C on Route 1J:** baseline 358.285 in ~38s; adding the 69-door candidate
costs +39.2s and returns 3.722 miles → **~0.095 miles saved per extra second**.
A 2-candidate portfolio therefore roughly doubles solve time for ~1% mileage.
That is the number the production compute budget should be argued from.

**Not yet proven, and required before any production default changes:** the same
candidate set measured on dense/grid suburban, cul-de-sac heavy, single-entry
subdivision, river/lake barrier, highway-separated, sparse exurban, rural, and a
second mixed 1,000-home territory.

## Unchanged by any of this

Candidate decomposition varies. The truth hierarchy does not: real road cost for
every ordering decision, zero aerial order decisions, exact-once membership, one
route per 1,000-home Precision pull, unresolved road cost fails instead of
guessing, seam refinement, hotspot refinement, independent final road
measurement, lowest verified mileage wins.

## Frozen finding — Route 1I (1,000 doors, Charlotte): compactness vs road connectivity

The 11.927-mile transition in Route 1I was traced to decomposition, not to macro
ordering and not to the start/end cut (both were proven optimal). Window 0
contained two pieces that are **aerial-near / road-far**: Ventana Ct and Quaker Rd
sit 2.202 mi apart in the air and 11.927 mi apart to drive — a barrier straddle
the intra-window solver cannot escape, because both doors are its members.

Experiment A (`coarseBlockOrder`, single variable, deterministic across two runs):

| | geometric baseline | coarse road-ordered |
|---|---|---|
| total road miles (pre-hotspot) | 519.691 | **511.590** |
| longest leg | 11.927 (aerial 2.202) | 11.666 (aerial 9.022) |
| p90 / p95 | 1.238 / 1.753 | 1.170 / 1.657 |
| legs > 1 mi | 138 | 130 |
| legs > 5 mi | 3 | **4** |
| top-10 transition total | 50.706 | **53.351** |
| windows | 16 | 11 |

Ventana and Quaker land 194 stops apart under coarse grouping, so the barrier
class is genuinely removed. The surviving longest leg is a **different failure
class**: 9.0 mi aerial driven in 11.7 mi is a real long haul to an isolated
pocket, not a barrier mistake. 1I therefore is not a pure barrier fixture.

**The lesson, frozen:** geometric decomposition preserves compactness but can
straddle road barriers; pure road grouping respects access but sprawls and worsens
the tail (same direction as 1J's 386.0 mi and the earlier 417.9 mi road-access
grouping). So the next problem is **not** "make grouping road-aware" — it is
**road-aware barrier separation that preserves compactness**.

`coarseBlockOrder` stays OFF. Nothing from 1I ships on 1I alone.

## PRODUCTION-FROZEN — barrier-aware compactness repair (2026-08-15)

The research target below was met. Barrier repair passes the acceptance bar and is
the frozen reference behavior for the initial Precision Generation solver.

**The conclusion that matters:** we did **not** globally replace compact grouping
with road grouping. We preserved compact geographic decomposition and selectively
repaired only windows where real road evidence proved the grouping crossed a
barrier. Candidate acceptance remains independently verified real road mileage, so
the repair is never chosen unless it actually produces the shorter valid route.

### Route 1I (1,000 doors — permanent barrier regression)

Fixture: `test/fixtures/charlotte-route-1i-barrier-1000.json` (unordered door set,
checksummed, routing attributes only). Re-measure with
`node scripts/route-barrier-freeze-benchmark.mjs`.

| | geometric | coarse road grouping | **barrier repair** |
|---|---|---|---|
| verified road miles | 518.296 | 511.590 | **502.840** |
| longest leg | 11.927 | 11.666 | **6.033** |
| p95 / p99 | 1.750 / 3.491 | 1.657 / 3.490 | 1.693 / 3.491 |
| top-10 transition total | 50.325 | 53.351 | **42.536** |
| legs > 5 mi | 3 | 4 | **1** |
| windows | 16 | 11 | 16 |
| accepted | no | no | **yes** |

Repair scope: **1 of 16 windows straddling · 2 street blocks · 3 doors moved.**
Exact-once, zero aerial ordering decisions, 100% road-priced legs.
(The 518.296 baseline replaces the earlier 519.691 pre-hotspot figure; coarse
reproduced 511.590 exactly, confirming the harness rather than the drift.)

### Generalization on unrelated real routes

| route | doors | geometric | barrier repair | straddles found |
|---|---|---|---|---|
| Charlotte 1J | 1,000 | 358.285 | **354.704** | 1 |
| Salisbury | 382 | 616.589 | **602.954** | 3 (p99 11.961 → 8.387) |
| East Valley | 488 | 327.798 | 327.798 (identical order retained) | 0 |
| Mesquite | 58 | exact small-route tier, unchanged | — | n/a |

East Valley is the important negative result: with no barrier present the repair
detects nothing, changes nothing, and costs nothing beyond the coherence check. A
solver that leaves good routes alone is the requirement, not a side effect.

### Barrier-repair telemetry (documented contract)

`barrierWindowRepair` reports, and `roadHierarchySequencer` merges into route
telemetry: `barrier_windows_checked`, `barrier_straddling_windows`,
`barrier_blocks_moved`, `barrier_doors_moved`, `barrier_repair_passes`,
`repair_matrix_requests`, `repair_road_pairs`. The strategy label is
`barrier_repaired_geometric_windows` **only when blocks actually moved**; a
detected-nothing route keeps `geometric_windows`, so the stored strategy can never
claim a repair that did not happen. Unresolvable road cost during repair fails the
sequencing — the caller keeps the route it already had.

### Frozen Precision contract

up to 1,000 homes → ONE initial route → real-road ordering only → exact-once →
compact topology → barrier repair where justified → seam/hotspot refinement →
independent final road verification → **fail rather than guess**.

Future solver changes require a benchmarked regression or a newly demonstrated
failure class — not visual preference or speculative tuning. `coarseBlockOrder`
stays OFF (kept as research infrastructure only).

## Route-size bug found during this work

A window whose coordinate chunk contained a **single point** made the routing
engine reject the request outright (HTTP 400, invalid options), which killed
optimization for every route that happened to decompose onto that boundary. A
one-point matrix is now answered locally as zero cost without a network call.
Pinned by MTX-07 in `test/road-matrix-chunking.test.mjs`.