# Route 1I — old splitter vs K-way partitioner (live benchmark record)

Fixture `test/fixtures/charlotte-route-1i-barrier-1000.json` (1,000 real doors).
Both engines scored identically: same frozen sequencer per route, same independent
road measurement per route, same atom set for structural metrics.

    node scripts/route-split-benchmark.mjs test/fixtures/charlotte-route-1i-barrier-1000.json \
         --k=2,3,5,10,20,50,100 --out=/tmp/bench-1i.ndjson

## Final strict-validity curve

Every winning finalist satisfies `exact K + exact-once + declared balance` before
verified mileage is considered. Balance relaxation mode is off throughout.

| K | Target | Allowed | Actual | Deepest granularity | Parents subdivided | Below/above | True relaxations | Exact K / once | Old mi | New mi | Saved | Winner |
|---|---:|---:|---:|---|---:|---:|---:|---|---:|---:|---:|---|
| 2 | 500 | 470–530 | 483–517 | unit | 0 | 0 / 0 | 0 | yes / yes | 510.336 | **477.731** | 32.605 | balance_led@moderate |
| 3 | 333.33 | 326–340 | 330–336 | unit | 0 | 0 / 0 | 0 | yes / yes | 474.684 | **471.413** | 3.271 | peripheral_seeds@tight |
| 5 | 200 | 196–204 | 197–203 | unit | 0 | 0 / 0 | 0 | yes / yes | 468.177 | **465.791** | 2.386 | balanced_road_growth@tight |
| 10 | 100 | 94–106 | 95–106 | unit | 0 | 0 / 0 | 0 | yes / yes | 472.912 | **454.621** | 18.291 | balance_led@moderate |
| 20 | 50 | 47–53 | 47–53 | door group | 8 | 0 / 0 | 0 | yes / yes | 476.640 | **446.012** | 30.628 | balance_led@moderate |
| 50 | 20 | 18–22 | 18–22 | door group | 168 | 0 / 0 | 0 | yes / yes | 461.668 | **452.987** | 8.681 | topology_first@moderate |
| 100 | 10 | 8–12 | 8–12 | door group | 168 | 0 / 0 | 0 | yes / yes | 422.761 | **400.175** | 22.586 | balance_led@loose |

The scale transition is explicit: K=2–10 keep all 664 natural units intact;
K=20 descends selectively to 8 door-group atoms; K=50/100 descend to 179
door-group atoms after subdividing 168 oversized unit/block parents. The resulting
759-atom table remains under the bounded 800-atom ceiling. No workload-contract
relaxation was used to admit high-K candidates.

## Final high-K route-mileage shape

| K | Old short / med / p90 / long | New short / med / p90 / long |
|---|---|---|
| 50 | 2.246 / 8.544 / 14.103 / 22.516 | 3.306 / 8.178 / 14.775 / 25.396 |
| 100 | 0.915 / 3.382 / 7.004 / 17.650 | 0.390 / 3.054 / 8.025 / 13.301 |

## Historical K=5 diagnosis (before the strict balance contract)

This section is retained as provenance only. Its one-sided balance findings and
follow-up recommendations are superseded by the final strict-validity curve above.

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

* Route 1I is complete: all seven K values pass strict balance, exact-K,
  exact-once, and independent road-mileage verification.
* No production cutover. `SplitRouteModal` still uses the old splitter.
* Route 1J has not been hydrated or benchmarked.
* Pre-existing unrelated failures still present: DEP-02 / DEP-03 in
  `test/route-module-dependencies.test.mjs`.