# BatchData corrected-contract capability probe

Date under test: July 9, 2026 (America/Phoenix). Recent-sale requests ended at July 8, 2026 so “yesterday” was tested explicitly.

## Bottom line

The corrected Search filters work on the current token, but rich property enrichment does not: `core`, `listing`, `deed`, and `valuation` all return `dataset_not_allowed`. Correctly shaped basic Lookup requests succeeded in three of three cities and returned the same property identity, so the prior claim that Lookup itself was nonfunctional is not supported. The correct diagnosis is an account entitlement gap.

Intel and Sale are alternative predicates on Property Search, not separate discovery endpoints. Across the four 25-square-mile polygons, Intel returned 38 candidates over 14 days and Sale returned 32. The entire difference came from Seattle (31 Intel versus 25 Sale). Counts alone cannot prove set inclusion, so maximum recall still requires paginating both and de-duplicating their record-level union.

## Observed counts

| Polygon | Yesterday Intel / Sale | 14-day Intel / Sale | Qualified Intel / Sale |
|---|---:|---:|---:|
| Phoenix, AZ | 0 / 0 | 5 / 5 | 5 / 5 |
| Charlotte, NC | 0 / 0 | 1 / 1 | 1 / 1 |
| Dallas, TX | 0 / 0 | 1 / 1 | 1 / 1 |
| Seattle, WA | 0 / 0 | 31 / 25 | 11 / 7 |
| Sum, not a de-duplicated union | 0 / 0 | 38 / 32 | 18 / 14 |

“Qualified” applied all three provider filters:

- `general.standardizedLandUseCode.equals = "R2"`
- `valuation.estimatedValue.min = 100000`
- `listing.statusCategory.notInList = ["Active", "Pending"]`

All count requests used `options.datasets = ["basic"]`. Every filter request returned HTTP 200.

## Which gate reduced density?

The Seattle controls are unusually clear:

| Predicate | Baseline | R2 only | $100k only | Exclude Active/Pending only | All three |
|---|---:|---:|---:|---:|---:|
| Intel | 31 | 11 | 31 | 31 | 11 |
| Sale | 25 | 7 | 25 | 25 | 7 |

In this polygon and window, the full reduction came from the provider’s R2 classification. The $100k value floor and for-sale exclusion removed no additional records. Phoenix’s Sale count stayed at five under each individual filter and all three combined. Charlotte and Dallas also retained their complete one-record baselines under the combined filters.

This does not prove those two filters never matter. It proves they did not cost density in these sampled polygons and dates. R2 is the gate that most needs recall auditing against an independent ground-truth source.

## Corrected Lookup result

The corrected request used:

```json
{
  "requests": [
    {
      "address": {
        "street": "[not persisted]",
        "city": "[not persisted]",
        "state": "[not persisted]",
        "zip": "[not persisted]"
      },
      "requestId": "probe-id"
    }
  ],
  "options": {
    "datasets": ["basic"]
  }
}
```

Basic Lookup returned HTTP 200 and an identity match in Phoenix, Charlotte, and Dallas. It did not expose SFR classification, value, listing status, deed history, or sale-date evidence.

One correctly shaped rich Lookup and three rich Search samples requested `core`, `listing`, `deed`, and `valuation` under `options.datasets`. All returned HTTP 400 with `dataset_not_allowed`; the provider warning named all four datasets as unavailable for the token. Therefore the app cannot use rich Lookup as its local truth layer until the token is entitled to the necessary datasets.

## Could qualified `basic` Search feed the pre-provenance mapper?

Not through the then-current strict returned-date gate. A final three-call supplement requested one qualified Intel record from Phoenix, Charlotte, and Dallas using `options.datasets = ["basic"]`. All three calls returned HTTP 200 and one record.

The useful location fields were present:

- Complete structured address: 3/3
- Latitude: 3/3
- Longitude: 3/3
- Complete coordinate pair: 3/3

The date evidence was absent. Every direct, deed, listing, transaction, and mortgage path accepted by `selectRecentSaleEvidence` was checked. Each path was present in 0/3 records. `quickLists.recentlySold` was also absent in 3/3.

Running the actual pure selector produced:

- Exact date present: 0/3
- Exact date inside June 25 through July 8: 0/3
- Selector source `none`: 3/3
- Selector confidence `none`: 3/3
- Purchase-mortgage evidence: 0/3

This closed the earlier instrumentation gap: for these three qualified basic records, the pre-provenance mapper's `missingSaleDateRejected` gate would reject all three. Provider-side acceptance of `intel.lastSoldDate` did not cause the qualifying date to appear in the `basic` payload.

The safe property-key union was only `_id`, `address`, `ids`, and `owner`. The relevant `intel`, `sale`, `lastSale`, `deed`, `listing`, `transaction`, `quickLists`, `openLien`, `deedHistory`, and `mortgageHistory` namespaces were absent.

## Cursor pagination contract

A final two-call test used the qualified 14-day Seattle Intel criteria with `take: 1`, `datasets: ["basic"]`, and `useCursorPagination: true`.

- Page 1: HTTP 200, one returned record, 11 reported matches, `nextPageCursor` present.
- Page 2: the identical criteria plus the opaque cursor verbatim under `pageCursor`; HTTP 500, zero records, no cursor.
- Identity difference: not measurable because page 2 returned no record.

No cursor value or property identity was retained. This single no-retry round-trip cannot distinguish a permanent token limitation from a transient provider failure, but it does prove that cursor pagination cannot be the only production path. A bounded offset fallback is required.

## Implications for the route pipeline

1. Use both Intel and Sale Search predicates and form a record-level union. Do not intersect them and do not assume equal counts mean equal records.
2. Apply R2, the $100k estimated-value floor, and Active/Pending exclusion provider-side to limit spend and improve candidate quality. Preserve the exact predicate/filter provenance on every candidate.
3. Do not claim locally verified SFR/value/listing evidence from a `basic` response. The current token does not return those proof fields.
4. A `basic` response cannot independently satisfy an exact returned-date gate. Production now admits only exact-job candidates whose submitted provider predicates prove the selected date/R2/value/listing bounds, while exact returned contradictions still reject. Resolve dataset entitlement before treating Lookup as a rich independent validator, then rerun the same three-city identity and field-presence probe.
5. To answer “24 qualifying homes exist, did we route all 24?”, obtain an independent recorder/MLS truth set and calculate recall. BatchData-versus-BatchData counts only measure internal consistency, not penetration.

Cursor pagination should be attempted only with an automatic bounded offset fallback; the first live cursor round-trip failed on page 2.

## Exposure and privacy

The five probe phases made 48 HTTP attempts with no retries: 33 count-only Search requests, 11 one-record Search requests, and four Lookup requests. Responses were 43 HTTP 200, four HTTP 400 entitlement failures, and one HTTP 500 cursor round-trip failure. Seven Search records and three basic Lookup rows were returned. The provider dashboard remains the source of truth for billing, including minimum charges for `take: 0` and any treatment of failed entitlement requests.

No API key, address, property identifier, response hash, or raw provider payload was persisted. The machine-readable artifact contains only counts, status codes, field-presence results, warnings, and aggregate identity-match booleans.

## Reproduction

Runner: `test_batchdata/run-corrected-contract-probe.mjs`

The runner is plan-only by default. The first command below prints its request/privacy plan and makes no network request. Live execution requires both `--confirm-live` and a bounded per-process HTTP budget.

```powershell
node test_batchdata/run-corrected-contract-probe.mjs --budget=40
node test_batchdata/run-corrected-contract-probe.mjs --confirm-live --budget=40
node test_batchdata/run-corrected-contract-probe.mjs --confirm-live --lookup-only --budget=10
node test_batchdata/run-corrected-contract-probe.mjs --confirm-live --seattle-filter-controls --budget=10
node test_batchdata/run-corrected-contract-probe.mjs --confirm-live --mapper-evidence --budget=5
node test_batchdata/run-corrected-contract-probe.mjs --confirm-live --cursor-contract --budget=2
```

Machine-readable results: `documentation/validationlayer/batchdata_corrected_contract_probe_2026-07-09.json`

## Limitations

- Four polygons are sufficient for a contract/capability probe, not a national penetration estimate.
- Count equality cannot establish record equality or a de-duplicated union size.
- Provider acceptance of R2 is not an independent audit of land-use correctness.
- Rich field behavior could not be observed because the token lacks the requested datasets.
