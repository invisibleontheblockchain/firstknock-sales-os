# Road-aware hierarchy for 1,000-door Precision routes

## Outcome

A Precision route of up to 1,000 doors stays ONE route, and every distance
comparison that can change which street, block, pocket or neighbourhood the rep
visits next is decided on drivable road mileage.

Aerial distance survives in exactly one place: ordering doors along a single
street block whose traversal topology is already fixed. That value cannot change
route order, only the direction a rep walks a segment they are walking anyway.

## Non-goals

- Splitting a 1,000-door route into smaller user-facing routes.
- A 1,000 x 1,000 OSRM matrix (484 table requests; not affordable).
- Replacing the cluster tier. Clustering is a sound scaling strategy; the defect
  is that it has no road cost *inside* a cluster.
- Retuning the door tier (<= 250 doors). It is already exact and proven.

## Root cause being fixed

`createTieredMatrixMetricFns` prices a leg with `haversineMiles` whenever both
doors resolve to the same matrix unit. At block tier that unit IS a street block,
so the aerial value cannot change route order. At cluster tier the unit is a
k-d-bisected group of many blocks spanning many streets, so:

- cross-street sequencing inside a cluster is decided aerially, and
- if it were not, both doors would resolve to the same cluster representative and
  the matrix would price the leg at 0 miles.

There is therefore no road cost available for intra-cluster decisions today. That
is what produces Charlotte 1J's 210 -> Eaton -> Airport -> Airline backtrack, and
it is the same mechanism that makes two shoreline pockets across water look
adjacent.

## Architecture: two bounded levels

```
1,000 doors
  -> street blocks (buildStreetBlocks, existing)
  -> clusters of blocks (partitionBlocksIntoClusters, existing)
  -> LEVEL 1: matrix over cluster representatives  -> cluster ORDER (road)
  -> LEVEL 2: per cluster, matrix over that cluster's block representatives,
              plus the entry/exit ports fixed by level 1
                                                   -> block ORDER (road)
  -> flatten each block to doors in house-number order (aerial, order-neutral)
  -> ONE 1,000-stop order
  -> LEVEL 3: measure the stored order on real roads (OSRM /route) and persist
              its geometry
```

### Level 1 — cluster order

Unchanged in shape from today: <= 250 points (cluster representatives + anchors),
one `fetchRoadMatrix`, solved for cluster order on road distance.

### Level 2 — block order inside each cluster

For each cluster, in the order level 1 produced:

- Build the cluster's street blocks (already computed while planning).
- Matrix points = one representative per block, plus two **ports**: the door the
  rep arrives from (previous cluster's exit) and the door they leave toward
  (next cluster's entry). Ports make the internal order respect where the rep
  enters and exits, which is the whole reason an isolated per-cluster solve is
  not sufficient.
- Cluster block counts are bounded by construction: level 1 exists only when
  `blockCount > blockBudget`, and clusters are median-bisected, so a cluster
  carries roughly `blockCount / clusterCount` blocks. A cluster whose block
  count still exceeds the matrix budget is bisected again rather than priced
  aerially — the recursion is on the same bounded primitive.
- If a cluster's DOOR count fits the matrix budget, price its doors directly
  (door tier within the cluster) instead of block representatives. This is the
  "do not request a full door-to-door matrix unless the cluster is small enough"
  rule, expressed as a budget check rather than a heuristic.

### Level 3 — final reality check

The search may approximate; the stored route may not. After the final order is
fixed, `measureRoadPath` walks the order through OSRM's `/route` service in
bounded chunks and returns:

- per-leg road distance for all 999 legs,
- total actual road miles,
- the longest single road transition,
- the real driven geometry (polyline), stitched across chunks.

That total is the number shown to the manager, and the geometry is what the map
draws, so the drawn line and the quoted mileage come from the same source.

## Request-storm control

Every OSRM call — level 1 blocks, level 2 matrices, level 3 route chunks — is
enqueued through ONE process-wide `osrmDispatcher`: a fixed concurrency cap, a
minimum spacing between dispatches, and bounded retry with backoff on 429/5xx.
Level 2 fan-out is the reason this is mandatory: N clusters x their own matrix
blocks would otherwise multiply against level 1's own concurrency.

## Determinism

No randomness, no iteration-order dependence, and the same deterministic step
budget the sweep already uses. Level 2 solves are independent given level 1's
order and its ports, so the result is reproducible across hardware.

## Verification plan

Network-free unit tests for planning, port derivation, budget recursion and
telemetry. Then before/after on two REAL routes:

| Metric | Source |
| --- | --- |
| total actual road miles | level 3 |
| longest road transition | level 3 |
| final road legs | `classifyFinalRouteLegs` |
| final aerial same-street legs | `classifyFinalRouteLegs` |
| final aerial cross-street legs | must be 0 after |
| access-pocket re-entries | continuity access blocks |
| road_aware_degraded | routing metadata |
| stored geometry available | level 3 |

Fixture 1: Charlotte Precision Route 1J (`6a7e7a1c3efa45ba79c806bf`, 1,000
doors) — committed at `src/test/fixtures/charlotte-route-1j-ashley-circle.json`.

Fixture 2: Lake Norman — **BLOCKED, route not identified.** No route in this
account is on Lake Norman; the "Denver Precision Route 1" candidate is Denver,
Colorado (39.7N, -104.9W). Needs the route name or id from the user before it can
become a regression.

## Status

- [x] Telemetry honesty (previous pass): candidate vs final legs, degraded status.
- [x] Design.
- [ ] `osrmDispatcher` — bounded shared queue.
- [ ] `measureRoadPath` — level 3 real mileage + geometry.
- [ ] `sequenceRouteHierarchically` — levels 1 and 2.
- [ ] Wire into `optimizeRouteRoadMatrix`, persist geometry.
- [ ] Before/after on both fixtures.