# Route Splitting at Scale — Plan

Verified against `src/components/logic/routeOptimizer.jsx` (current working copy), not the report's PR #85 baseline.

## Confirmed in current code

1. **No spatial partitioning before splitting.** Line ~747: `let clustered = scored.map(p => ({ ...p, cluster: 0 }))`. The cluster loop under it runs exactly once, so "N routes" = positional slices of ONE global street-ordered sequence (`splitOrderedPropertiesByRoutingBoundaries`). Adjacent reps are order-neighbors, not territories. This is the splitting problem.
2. **Working k-means is dead code.** `kMeansClustering` / `kMeansPlusPlusInit` (lines 281–381) are never called. `detectGeoClusters` / `kMeansAssign` / `orderClustersByNN` are also unused.
3. **Scale cliffs inside ordering (why small routes look right and big ones bounce):**
   - `orderStreetsByNearestNeighbor`: >500 streets → drops to lat/lng boustrophedon sort.
   - `optimizeStreetBlockOrder`: >500 blocks → same spatial-sort fast path, no NN, no refinement.
   - Refinement (2-opt + or-opt over blocks) only runs at `ordered.length <= 120` (40 in cost-only road mode).
   - Scoring fast path at >5000 properties; road-metric legs skipped in cost-only mode.
4. **`apply2Opt` 300-node bail-out** is real but only affects `optimizeRouteByDistance` (the "distance" optimize mode), not the street-sweep generation path.

Report claims NOT verified here (do not act on yet): the BatchData `PAID_PROPERTY_CAP = 1000` / `max_available` diff, and every OSRM-hosting item. We already have `optimizeRouteRoadMatrix` + `base44/shared/roadMatrix.js`, so the report's `src/services/osrmClient.js` proposal would duplicate existing architecture.

## Plan (in order, each independently shippable)

**Phase 1 — Partition before ordering (the actual fix).**
- In `generateOptimizedRoutes`, replace the `cluster: 0` stub with `kMeansClustering(scored, K)` where `K = ceil(scored.length / housesPerRoute)` — one zone per rep route.
- Add `balanceClusterCapacity(clustered, housesPerRoute)`: move the members farthest from their own centroid into the nearest zone that still has room (bounded iterations). k-means alone gives lopsided zones, and each zone becomes one rep's day.
- Leave the existing per-cluster loop, `mailCarrierOrder`, and `splitOrderedPropertiesByRoutingBoundaries` untouched — the split becomes a per-zone safety net for a single street longer than `housesPerRoute`.
- Reject the report's competing `clusterSizeMultiplier = 4` + `stitchClusterOrders` variant: coarse cells re-introduce cross-zone slicing, which is the bug. One zone per route, no stitching.
- Ignore the report's literal indices `remaining[3]`, `candidateTargets[4]`, `data.routes[2]` — they contradict their own comments and are bugs.

**Phase 2 — Keep refinement alive per zone.**
Each zone is ~`housesPerRoute` doors, so street/block counts land under the 500-block and 120-block cliffs naturally: refinement re-activates for free. Confirm with the existing fixtures rather than raising the caps (unbounded thresholds are a known dead end here).

**Phase 3 — Guards and evidence.**
- `assertExactRouteMembership` already fails closed on lost/duplicated doors; keep it as the partition's safety net.
- Add a regression test asserting each generated route's bounding-box diagonal shrinks vs. today on a large fixture (Charlotte 95 / Anderson 183), and that no route spans more than one zone.
- Run `test/route-street-sweep`, `route-anderson-never-worse`, `route-solver-budget`, `route-determinism-harness` before/after.

**Phase 4 — Call-site check (small).**
Confirm `src/pages/Home.jsx` and `src/pages/ZipCodeExplorer.jsx` pass `housesPerRoute` (not a raw route count) into `generateOptimizedRoutes`; `K` derives from it, so a wrong unit silently produces the wrong zone count.

**Deferred:** BatchData `max_available` cap and any OSRM hosting work — separate tracks, verify the live files first.