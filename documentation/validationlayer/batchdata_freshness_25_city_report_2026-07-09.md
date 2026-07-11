# BatchData 25-City Freshness Test

> **Contract and policy correction:** the relative Intel/Sale counts remain useful because both requests had the same shape, but this run's top-level `datasets` field did not validate response-dataset enrichment. The implementation conclusions in this report have been corrected to use the valid `options.datasets` contract, independently union both qualified streams, and preserve exact provider-filter provenance. See [the corrected-contract probe](./batchdata_corrected_contract_probe_report_2026-07-09.md) and [the maximum-recall route policy](./batchdata_max_recall_route_policy_2026-07-09.md).

Date executed: 2026-07-09
Timezone: America/Phoenix
Yesterday tested: 2026-07-08
Windows: 1 day = 2026-07-08 only; 2 days = 2026-07-07 through 2026-07-08; 7 days = 2026-07-02 through 2026-07-08; 14 days = 2026-06-25 through 2026-07-08.

## Executive verdict

1. **Neither Search predicate returned a candidate for the one-day request in any of the 25 cities.** The request used `minDate: 2026-07-08` and `maxDate: 2026-07-08` in both nominal 25-square-mile freehand-style polygons and city/state controls. Because Search usually hid the qualifying date, this is a provider-predicate result, not independent proof about every deed recorded yesterday.
2. **The freehand-polygon result was also zero for both predicates at 2 and 7 days in every city.** Inventory first appeared at 14 days: Intel returned 145 candidates and Sale returned 139.
3. **The city/state control found one Intel-only Orlando candidate at 2 days.** It exposed no returned sale date. Its HTTP-successful Lookup row exposed no Intel date, explicit type, or deed history and did not increase the populated-value count in the monitored 11-field vector, so it cannot be treated as a verified recent sale. At 7 days, Intel returned Orlando plus Denver; Sale returned Denver only.
4. **At 14 days, Intel is slightly more inclusive, but this test has no external ground truth proving either predicate more accurate.** Polygon counts matched in 24/25 cities; Seattle was 31 Intel versus 25 Sale. City/state counts matched in 21/25; Intel was higher in Houston, Orlando, Denver, and Seattle. Sale was never higher.
5. **Lookup did not demonstrate the proposed 700-attribute truth layer for this key and request contract.** `/property/lookup` returned 404. `/lookup/all-attributes` produced 36 HTTP-successful responses with extractable first rows, but none increased the populated-field count in the monitored vector; the returned Lookup samples contained zero `intel.lastSoldDate`, zero explicit property type, and zero deed history.
6. **Production recommendation: independently paginate and union both qualified predicates.** Intel found candidates that Sale omitted, while the sampled record sets also showed that equal counts do not prove equal identities. Neither predicate is an external truth set. Route admission therefore requires the exact job-scoped R2, value, listing-exclusion, polygon, and date proof sent for that stream; any contradictory returned field still rejects the record.

## Test design

- 25 geographically diverse cities.
- Matched nominal 5-mile by 5-mile center-city polygons for the freehand-map use case.
- A second city/state geography pass to detect polygon-specific behavior.
- Identical `datasets: ["basic"]`, geometry, date range, and `take: 0` for Intel versus Sale counts.
- Intel predicate: `searchCriteria.intel.lastSoldDate`.
- Sale predicate: `searchCriteria.sale.lastSaleDate`.
- These are two filter predicates on the same `POST /api/v1/property/search` endpoint. Lookup was tested separately as targeted enrichment; it cannot discover a city/date-window population by itself.
- Both `minDate` and `maxDate` were accepted with HTTP 200. A historical-cutoff control showed a one-record reduction for each predicate in Denver city/state when `maxDate` moved from July 8 to July 1, which demonstrates a semantic `maxDate` effect in that control. Sparse returned dates prevent extending that proof to every match and geography.
- Up to five returned rows per predicate were cross-referenced in the freshest nonzero polygon window.
- Up to two union records per sampled city were sent to `/lookup/all-attributes`.
- No addresses, owners, API credentials, provider error bodies, or raw provider payloads were retained.

## Aggregate comparison

Each count is shown as **Intel / Sale**.

| Geography | 1 day | 2 days | 7 days | 14 days |
|---|---:|---:|---:|---:|
| Nominal 25 sq mi polygons | 0 / 0 | 0 / 0 | 0 / 0 | 145 / 139 |
| City/state controls | 0 / 0 | 1 / 0 | 2 / 1 | 1,621 / 1,601 |

| Geography/window | Intel cities with data | Sale cities with data | Equal-count cities | Intel higher | Sale higher |
|---|---:|---:|---:|---:|---:|
| Polygon 1d | 0 | 0 | 25 | 0 | 0 |
| Polygon 2d | 0 | 0 | 25 | 0 | 0 |
| Polygon 7d | 0 | 0 | 25 | 0 | 0 |
| Polygon 14d | 17 | 17 | 24 | 1 | 0 |
| City/state 1d | 0 | 0 | 25 | 0 | 0 |
| City/state 2d | 1 | 0 | 24 | 1 | 0 |
| City/state 7d | 2 | 1 | 24 | 1 | 0 |
| City/state 14d | 20 | 20 | 21 | 4 | 0 |

All 200 matched Intel/Sale window pairs returned HTTP 200: 25 cities × 4 windows × 2 geographies, representing 400 predicate calls. Every city curve was monotonic.

## Upper-bound semantic control

The control held `minDate` at 2026-06-25 and compared `maxDate: 2026-07-01` against the primary `maxDate: 2026-07-08` for Houston, Seattle, and Denver.

| Geography/city | July 1 Intel / Sale | July 8 Intel / Sale | Change |
|---|---:|---:|---:|
| City/state Houston | 492 / 490 | 492 / 490 | 0 / 0 |
| City/state Seattle | 134 / 118 | 134 / 118 | 0 / 0 |
| City/state Denver | 177 / 176 | 178 / 177 | +1 / +1 |
| Polygon Houston | 31 / 31 | 31 / 31 | 0 / 0 |
| Polygon Seattle | 31 / 25 | 31 / 25 | 0 / 0 |
| Polygon Denver | 28 / 28 | 28 / 28 | 0 / 0 |

Denver's returned city/state sample exposed a 2026-07-02 date, and both predicates lost exactly one candidate when the upper bound moved to July 1. This supports semantic enforcement for that control. The unchanged markets are consistent with the observed feed lag and do not independently prove or disprove enforcement.

## Equal-area polygon results

| City | 1d I/S | 2d I/S | 7d I/S | 14d I/S |
|---|---:|---:|---:|---:|
| Anderson, SC | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Austin, TX | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 |
| Phoenix, AZ | 0 / 0 | 0 / 0 | 0 / 0 | 5 / 5 |
| Charlotte, NC | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Indianapolis, IN | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Atlanta, GA | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Dallas, TX | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Houston, TX | 0 / 0 | 0 / 0 | 0 / 0 | 31 / 31 |
| San Antonio, TX | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Tampa, FL | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Orlando, FL | 0 / 0 | 0 / 0 | 0 / 0 | 6 / 6 |
| Jacksonville, FL | 0 / 0 | 0 / 0 | 0 / 0 | 11 / 11 |
| Nashville, TN | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Raleigh, NC | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Charleston, SC | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Denver, CO | 0 / 0 | 0 / 0 | 0 / 0 | 28 / 28 |
| Las Vegas, NV | 0 / 0 | 0 / 0 | 0 / 0 | 3 / 3 |
| Albuquerque, NM | 0 / 0 | 0 / 0 | 0 / 0 | 5 / 5 |
| Los Angeles, CA | 0 / 0 | 0 / 0 | 0 / 0 | 7 / 7 |
| Sacramento, CA | 0 / 0 | 0 / 0 | 0 / 0 | 7 / 7 |
| Seattle, WA | 0 / 0 | 0 / 0 | 0 / 0 | 31 / 25 |
| Columbus, OH | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Kansas City, MO | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 |
| Philadelphia, PA | 0 / 0 | 0 / 0 | 0 / 0 | 3 / 3 |
| Pittsburgh, PA | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Eight polygon markets had no candidate from either predicate even at 14 days: Anderson, Atlanta, Tampa, Nashville, Raleigh, Charleston, Columbus, and Pittsburgh.

Because every polygon used the same nominal 25-square-mile footprint, the 14-day aggregate candidate density was 0.232 Intel and 0.222 Sale candidates per nominal square mile across 625 square miles. Houston and Seattle tied for the highest Intel density at 1.24; Houston led Sale at 1.24, followed by Denver at 1.12 and Seattle at 1.00. This is BatchData candidate density, not recall against all true sales.

## City/state control results

| City | 1d I/S | 2d I/S | 7d I/S | 14d I/S |
|---|---:|---:|---:|---:|
| Anderson, SC | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Austin, TX | 0 / 0 | 0 / 0 | 0 / 0 | 21 / 21 |
| Phoenix, AZ | 0 / 0 | 0 / 0 | 0 / 0 | 200 / 200 |
| Charlotte, NC | 0 / 0 | 0 / 0 | 0 / 0 | 19 / 19 |
| Indianapolis, IN | 0 / 0 | 0 / 0 | 0 / 0 | 7 / 7 |
| Atlanta, GA | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Dallas, TX | 0 / 0 | 0 / 0 | 0 / 0 | 30 / 30 |
| Houston, TX | 0 / 0 | 0 / 0 | 0 / 0 | 492 / 490 |
| San Antonio, TX | 0 / 0 | 0 / 0 | 0 / 0 | 20 / 20 |
| Tampa, FL | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Orlando, FL | 0 / 0 | 1 / 0 | 1 / 0 | 29 / 28 |
| Jacksonville, FL | 0 / 0 | 0 / 0 | 0 / 0 | 80 / 80 |
| Nashville, TN | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 |
| Raleigh, NC | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Charleston, SC | 0 / 0 | 0 / 0 | 0 / 0 | 3 / 3 |
| Denver, CO | 0 / 0 | 0 / 0 | 1 / 1 | 178 / 177 |
| Las Vegas, NV | 0 / 0 | 0 / 0 | 0 / 0 | 133 / 133 |
| Albuquerque, NM | 0 / 0 | 0 / 0 | 0 / 0 | 70 / 70 |
| Los Angeles, CA | 0 / 0 | 0 / 0 | 0 / 0 | 42 / 42 |
| Sacramento, CA | 0 / 0 | 0 / 0 | 0 / 0 | 50 / 50 |
| Seattle, WA | 0 / 0 | 0 / 0 | 0 / 0 | 134 / 118 |
| Columbus, OH | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Kansas City, MO | 0 / 0 | 0 / 0 | 0 / 0 | 107 / 107 |
| Philadelphia, PA | 0 / 0 | 0 / 0 | 0 / 0 | 3 / 3 |
| Pittsburgh, PA | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

The four 14-day city/state disagreements were Houston (492/490), Orlando (29/28), Denver (178/177), and Seattle (134/118). Intel was higher in every disagreement.

## Address-level and Lookup cross-reference

- Polygon Search samples: 59 Intel rows and 59 Sale rows across 17 nonzero cities.
- Sample identity overlap: 58 common, one Intel-only, and one Sale-only. The difference occurred in Seattle's first five sampled rows.
- `intel.lastSoldDate` populated in Search samples: 0/118.
- Explicit property type populated in Search samples: 0/118.
- Deed history populated in Search samples: 0/118.
- `quickLists.recentlySold` was true in all 118 Search sample rows.
- Only 17/59 rows per predicate exposed any candidate sale/purchase date. Sixteen dates per predicate were inside the requested window; one Sacramento row exposed a stale 2012 date despite passing the 14-day provider predicate.
- Polygon Lookup: 30/30 HTTP-successful responses yielded an extractable first row. None increased the populated-value count in the monitored 11-field vector; the returned rows had zero Intel dates, zero explicit property types, zero deed history, and eight in-window candidate dates.
- Targeted city/state Lookup: 6/6 HTTP-successful responses yielded an extractable first row. None increased monitored population; the returned rows had zero Intel dates, zero explicit property types, zero deed history, and three in-window candidate dates.
- No returned Search or Lookup sample exposed a 2026-07-08 qualifying date.
- Legacy `/property/lookup`: HTTP 404 `URL not found`.

The most important mismatch was Orlando. Intel returned one 2-day candidate while Sale returned zero. The Intel row had `quickLists.recentlySold: true`, but Search returned no sale date. Its Lookup response supplied an extractable row but no monitored sale date, classification, or deed history and no increase in monitored populated-field count. It is therefore an unverified hint, not evidence of a confirmed two-day sale.

## Operational decision

- **Yesterday:** neither predicate returned a candidate for the one-day request in the tested markets; do not promise yesterday inventory from this snapshot.
- **1–7 day product windows:** do not promise availability. Run a count preflight and show a market-specific availability warning before a full pull. Confirm the preflight's credit treatment with BatchData.
- **14 days:** Intel may return candidates that Sale omits, and count equality does not prove record equality. Maximum-recall production must independently paginate both qualified predicates and de-duplicate their record-level union.
- **Lookup:** keep disabled for automatic enrichment until BatchData confirms the account contract and a controlled sample demonstrates the required returned fields.
- **Routing:** a lean `basic` row may use exact, job-scoped proof of the submitted R2, value, listing-exclusion, and date predicates when returned fields are omitted. Exact returned contradictions still reject; generic `quickLists.recentlySold` alone never qualifies a route stop.

## Execution and billing caveat

Across the polygon matrix, city/state control, targeted discrepancy checks, and the 62-call upper-bound control, the tests made 633 HTTP attempts: 595 Search and 38 Lookup. There were 631 HTTP-successful responses and two expected legacy Lookup 404s, with no retries. The exact BatchData credit charge is unknown and must be reconciled in the provider dashboard.

These are provider freshness measurements for one API key/account contract on one execution snapshot, not a permanent availability guarantee or an external penetration measurement. A licensed sold-record list matched by address or property ID is still required to calculate recall. Because raw responses were intentionally not retained, the reproducibility audit validates the sanitized derived JSON and runner logic rather than the underlying provider payloads.
