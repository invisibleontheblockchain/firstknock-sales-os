# Route 1I — old splitter vs K-way partitioner (live benchmark record)

Fixture `test/fixtures/charlotte-route-1i-barrier-1000.json` (1,000 real doors).
Both engines scored identically: same frozen sequencer per route, same independent
road measurement per route, same atom set for structural metrics.

    node scripts/route-split-benchmark.mjs test/fixtures/charlotte-route-1i-barrier-1000.json \
         --k=2,3,5,10,20,50,100 --out=/tmp/bench-1i.ndjson

## Result curve

| K | Old mi | New mi | Δ mi | Δ % | Homes old/new | Blocks split old/new | Pockets old/new | Interleave old/new | Winner | Runtime old/new s |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | 510.336 | **477.731** | −32.605 | −6.4% | 500–500 / 483–517 | 0 / 0 | 0 / 0 | 2.9% / 3.3% | balance_led | 26.4 / 59.7 |
| 3 | 474.684 | **474.478** | −0.206 | −0.0% | 333–334 / 301–354 | 0 / 0 | 0 / 0 | 6.5% / 3.4% | balanced_road_growth | 33.2 / 87.8 |
| 5 | **468.177** | 470.291 | +2.114 | +0.5% | 200–200 / 165–212 | 2 / 0 | 0 / 0 | 7.1% / 8.8% | balanced_road_growth | 33.4 / 129.5 |
| 10 | 472.912 | **441.156** | −31.756 | −6.7% | 100–100 / 73–106 | 3 / 0 | 0 / 0 | 14.7% / 10.9% | balanced_road_growth | 46.6 / 234.1 |
| 20 | 476.640 | **431.348** | −45.292 | −9.5% | 50–50 / 29–53 | 8 / 0 | 0 / 0 | 24.3% / 21.0% | balance_led | 17.4 / 90.0 |
| 50 | 461.668 | **413.596** | −48.072 | −10.4% | 20–20 / 2–22 | 17 / 0 | 0 / 0 | 41.2% / 30.3% | balance_led | 18.4 / 37.2 |
| 100 | 422.761 | **408.180** | −14.581 | −3.4% | 10–10 / 1–11 | 33 / 2 | 0 / 0 | 55.4% / 53.6% | peripheral_seeds | 29.4 / 47.3 |

New wins 6 of 7 K values. Repeated-area entries (pockets shared across routes) are
0 for both engines at every K except new K=100 (2 blocks), because the atom model
makes pocket splitting structurally impossible until atoms must be subdivided.
Road cost for the whole run: 400,000 unique pairs, 3,507,154 pair requests served,
**43.3% pair cache hit rate**, 1,710 matrices.

## Route mileage shape (guards against buying a total with one terrible route)

| K | Old short / med / p90 / long | New short / med / p90 / long |
|---|---|---|
| 2 | 243.1 / 255.2 / 264.8 / 267.3 | 226.4 / 238.9 / 248.8 / **251.3** |
| 3 | 149.5 / 151.8 / 169.1 / 173.4 | 124.9 / 160.4 / 183.4 / 189.2 |
| 5 | 71.5 / 98.0 / 108.5 / **114.7** | 68.0 / 87.7 / 126.6 / 141.6 |
| 10 | 30.0 / 44.3 / 60.7 / 70.5 | 27.9 / 45.2 / 56.4 / **59.3** |
| 20 | 11.7 / 22.5 / 35.0 / 40.6 | 10.3 / 19.6 / 29.2 / 40.1 |
| 50 | 2.2 / 8.5 / 14.1 / 22.5 | 0.2 / 7.7 / 13.5 / 20.0 |
| 100 | 0.9 / 3.4 / 7.0 / 17.7 | 0.0 / 3.6 / 7.5 / **9.7** |

## FLAG — the 6% balance band is enforced on ONE side only

| K | Target | Allowed range | Achieved | Max dev | Reported relaxations |
|---|---|---|---|---|---|
| 2 | 500 | 470–530 | 483–517 | 3.4% | 0 |
| 3 | 333.3 | 313–354 | 301–354 | 9.7% | 0 |
| 5 | 200 | 188–212 | 165–212 | 17.5% | 0 |
| 10 | 100 | 94–106 | 73–106 | 27% | 0 |
| 20 | 50 | 47–53 | 29–53 | 42% | 0 |
| 50 | 20 | 18–22 | **2**–22 | 90% | 0 |
| 100 | 10 | 9–11 | **1**–11 | 90% | 0 |

6% does **not** collapse into exact equality at high K — the opposite happens:

* `capacity = ceil(target × 1.06)` is enforced during growth, and every fallback
  past it is counted. That is why the max column always respects the band.
* `minLoad = floor(target × 0.94)` is enforced **only** inside refinement, which
  rejects moves that would drain a route. Growth itself can leave a seed region
  holding almost nothing, and refinement has no incentive to fill it: the
  surrogate objective rewards short tours, and a 1-home route is a very short tour.
* The relaxation counter therefore reports 0 while routes sit far under the floor.
  "0 relaxations" currently means "no capacity overflow", not "in band".

Under-fill is a real product defect at high K (a 1-home route at K=100), and the
report is currently misleading about it. Not changed yet — measured and flagged, as
agreed. Fix before cutover: enforce/attempt the floor during growth, and count
under-fill as its own relaxation class instead of hiding inside a cap counter.

## K=5 diagnosis (controlled counterfactuals, not tuning for "5")

    node scripts/route-k5-diagnosis.mjs test/fixtures/charlotte-route-1i-barrier-1000.json \
         --k=5 --tolerances=0,0.02,0.06,0.12 --old-ndjson=/tmp/bench-1i.ndjson

Every candidate verified in full (`verifyCandidates: 99`), one variable changed:

| Balance tolerance | New mi | vs old | Homes | Under-filled | Longest route | Distinct partitions |
|---|---|---|---|---|---|---|
| 0 (equality, the old rule) | 475.874 | +7.7 worse | 200–200 | 0 | 141.9 | 2 |
| 0.02 | 469.810 | +1.6 worse | 196–204 | 0 | 139.5 | 2 |
| 0.06 (current default) | 470.291 | +2.1 worse | 165–212 | 1 | 141.6 | 2 |
| 0.12 | **456.321** | **−11.9 better** | 107–225 | 1 | 156.9 | 4 |

Attribution, by elimination:

* **Not the balance constraint being too loose.** Forcing exact equality is the
  *worst* result (475.9). Tightening never helps.
* **Not a selection failure.** At all four tolerances the measured winner was
  selected and `selection_left_miles_on_table = 0`. No candidate the portfolio
  already produced beat the one it chose.
* **Not surrogate/verified disagreement — at this K.** The surrogate leader was the
  measured winner in all four runs. It *does* disagree at K=10 (balance_led scored
  the best surrogate, 363.2, but verified 442.5 vs the winner's 380.5 / 441.2), so
  full verification, not surrogate ranking, must decide selection.
* **Partly seed/search breadth.** At tolerances 0–0.06 the four strategies collapse
  into only **2 distinct partitions** (identical surrogate *and* identical verified
  miles pairwise). At K=5 the portfolio is effectively a 2-candidate search.
* **Mostly geography plus a binding balance band.** 1I has one long sprawling arm:
  the winning partition carries 140–157 mi on one route while the other four sit at
  65–113. The old 1-D sweep happens to cut that arm across two routes — its longest
  route is 114.7 mi — and at exactly K=5 that accidental cut is 2.1 mi cheaper
  overall, bought by splitting 2 street blocks (new splits 0). Relaxing the band to
  12% lets the new engine keep the arm whole *and* beat the old cut by 11.9 mi.

Conclusion: K=5 is a genuine loss, fully explained, and **no algorithm change is
justified by it**. Two portfolio-level follow-ups are supported by the evidence and
must be benchmarked across the whole K curve before adoption:

1. Add a looser-balance candidate (e.g. 12%) to the partition portfolio and let
   measured mileage decide — it would have won K=5 by 11.9 mi. Product cost: an
   uneven day (107 vs 225 homes), so this needs a per-K balance policy decision,
   not a blanket constant.
2. Add the old sweep-slice partition as one more candidate. Then the system can
   never knowingly ship a split with higher verified mileage than the old model —
   which is the production gate, and is different from keeping the old model as
   *the* splitter.

## Frozen optimizer parity

`test/frozen-sequencer-parity.test.mjs` (offline, 4 tests, passing):

* PARITY-01 large route (420 homes): facade order is object-for-object identical to
  `sequenceBestDecomposition(..., FROZEN_BASELINE_PORTFOLIO)` called directly, same
  verified miles.
* PARITY-02 large route never falls through to the small-route path.
* PARITY-03 a 40-home route is refused by the frozen path
  (`SINGLE_CLUSTER_USE_EXACT_MATRIX`) and ordered on the exact-matrix tier — the
  only new capability the facade adds.
* PARITY-04 the facade's default portfolio is the mandatory production baseline
  alone, so splitting cannot silently enable speculative decompositions.

## Status

* No production cutover. `SplitRouteModal` still uses the old splitter.
* Pre-existing unrelated failures still present: DEP-02 / DEP-03 in
  `test/route-module-dependencies.test.mjs`.
* Next: hydrate a real 1,000-door Route 1J population from the Precision/Neon path
  (the committed Ashley Circle fixture is a 16-stop probe and is not a substitute),
  then repeat this curve.