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

## Route-size bug found during this work

A window whose coordinate chunk contained a **single point** made the routing
engine reject the request outright (HTTP 400, invalid options), which killed
optimization for every route that happened to decompose onto that boundary. A
one-point matrix is now answered locally as zero cost without a network call.
Pinned by MTX-07 in `test/road-matrix-chunking.test.mjs`.