# BatchData Precision Provider Contract (v1)

`provider_contract_version: 1`, persisted on every new Precision `FetchJob` in
`dry_run_metadata.provider_contract_version`.

Endpoint: `POST https://api.batchdata.com/api/v1/property/search`

This document records what is **proven**, what is **inferred**, and what is
**unknown**. Anything not backed by an evidence ID below is not implemented.

---

## 1. Evidence inventory

| Evidence ID | Source | Capture date | Endpoint | Request mode | Raw request | Raw response | Redacted | Trusted for |
|---|---|---|---|---|---|---|---|---|
| BD-E01 | `src/tasks/batchdata-escalation.md` (payloads 1–3) | 2026-07-01 | property_search | polygon | **Yes, verbatim** | No — outcome counts only | No PII present | Exact outbound paths; polygon validity |
| BD-E02 | `src/tasks/todo.md` production review entries | 2026-06 → 2026-06-30 | property_search | polygon | Described | **Observed field facts, body not retained** | n/a | `intel.lastSoldDate` presence/format/value; R2 on returned rows; dataset-scoping behaviour; `take` limit |
| BD-E03 | `src/tasks/todo.md` (`options.take` review) | 2026-06 | property_search | polygon | Described | Error behaviour | n/a | `options.take <= 100` |
| BD-E04 | `documentation/.../Batchdatasenttous/Anderson_SC_Neighborhood_Sample_500.csv` + breakdown | 2026-05-18 | property_search | city/state + quicklist | No | **Provider-authored 500-row export** | Contains real PII — referenced in place, never copied | Provider field naming; property-type vocabulary |
| BD-E05 | BatchData's own example payload, quoted in `src/tasks/batchdata-escalation.md` | 2026-06 | property_search | city/state | **Yes, provider-supplied** | No | No PII | `intel.lastSoldDate.minDate` path; date-only bound format |
| BD-E06 | `documentation/.../newbatchdatafindings/batchdata.txt` (v15/v16 dataset spec) | 2025 | property_search | query | Example | Field tables | n/a | **Secondary corroboration only** — internal research, not provider documentation |
| BD-E07 | `test_batchdata/batchdata-results.json` | — | property_search | address query | No | **Transformed** — `rawFields.keys` only | Addresses present | Top-level property keys `_id, address, ids, listing, owner` |

Classification per the evidence rule:

- **Real provider capture:** BD-E01 (requests), BD-E04 (dataset), BD-E05 (provider example).
- **Observed response assertions (body not retained):** BD-E02, BD-E03 — recorded machine-readably in `test/fixtures/batchdata/responses/observed-response-assertions.json`.
- **Persisted/transformed record:** BD-E07. *Not* a raw provider response.
- **Internal research:** BD-E06. Never used alone to justify a parser path.
- **Synthetic:** everything in `responses/synthetic-failure-safety-cases.json`.

> **No raw BatchData response body for the Precision polygon call exists** in
> this repository, its git history, or the local environment. Per the
> insufficient-evidence rule the parser was **not** redesigned. Only proven
> integrity bugs were corrected, and every unproven path is listed in §7.

---

## 2. Exact outbound request contract

| User intent | Canonical FetchJob field | BatchData JSON path | Required/optional | Evidence |
|---|---|---|---|---|
| Drawn territory | `polygon` | `searchCriteria.address.geoLocationPolygon.geoPoints[]` (`{latitude, longitude}`, explicitly closed) | Required | BD-E01 |
| Oldest allowed sale date | `sold_months` / `ownership_range_days.max` | `searchCriteria.intel.lastSoldDate.minDate` (`YYYY-MM-DD`) | Required | BD-E01, BD-E05 |
| Newest allowed sale date | `ownership_range_days.min` (custom only) | `searchCriteria.intel.lastSoldDate.maxDate` | Conditional | **Sibling-inferred** from BD-E01/BD-E05 |
| Minimum home value | `filters.min_price` | `searchCriteria.valuation.estimatedValue.min` | Conditional | BD-E01 (payload 2) |
| Maximum home value | `filters.max_price` | `searchCriteria.valuation.estimatedValue.max` | Conditional | **Sibling-inferred** from BD-E01 |
| Residential scope | server contract | `searchCriteria.general.standardizedLandUseCode.equals = "R2"` | Required | BD-E01 (payload 2), BD-E02 |
| Pagination | server contract | `options.skip`, `options.take` (≤100) | Required | BD-E01, BD-E03 |
| Dataset selection | — | **`options.datasets` is never sent** | Prohibited | BD-E02 (OBS-02) |

Only two emitted paths are not literally present in a captured request
(`intel.lastSoldDate.maxDate`, `valuation.estimatedValue.max`). Both are the
documented siblings of a captured path inside the same provider object and both
carry a bound the user explicitly selected. They are enumerated in
`test/batchdata-contract-outbound-request.test.mjs`; the test fails if the list
grows.

### Why `options.datasets` is prohibited

A live no-write A/B probe on a single polygon (OBS-02) showed that scoping
datasets made the response omit the `intel` and `sale` objects and drove the job
to `active=0`, while the unscoped request on the same polygon returned rows with
`intel`/`sale` present. `intel` is not a member of `basic|listing|deed|owner`, so
**no** datasets array can include the field this request filters on.

`origin/main` and PR #66's branch were both sending
`datasets: ['basic','deed','owner']`. Combined with PR #66's new fail-closed
`missing_recorded_sale_date` rule, that combination delivers **zero** Precision
properties. This was the highest-severity finding of this pass.

---

## 3. Observed response shapes

Envelope: `results.properties` (array). Corroborated by three independent
internal sources — `batchDataWebhookCallback` in production,
`validateBatchDataShape`, and BD-E06. Not captured.

| FirstKnock concept | Observed / relied-on path | Evidence | Selection rule |
|---|---|---|---|
| Provider property ID | `ids.propertyId`, `ids.id`, `id`, `propertyId` | BD-E07 (`ids` key exists) | first non-empty |
| Street / City / State / ZIP | `address.street`, `address.city`, `address.state`, `address.zip` | BD-E04 column names; BD-E07 (`address` key) | first non-empty; ZIP truncated to 5 chars |
| Latitude / Longitude | `address.location.latitude/longitude` **or** `address.latitude/longitude` | **UNPROVEN** | first finite; both aliases retained deliberately |
| Recorded sale date | `intel.lastSoldDate` | BD-E02 (OBS-01, OBS-04) | authoritative; see §4 |
| Sale amount | `intel.lastSoldPrice`, `sale.*` | BD-E02 (OBS-06: frequently absent) | first positive number; never substituted for value |
| Estimated value | `valuation.estimatedValue`, `intel.*`, `assessment.*` | BD-E01 (request path), BD-E04 (`totalMarketValue`) | first positive number |
| Land-use code | `general.standardizedLandUseCode` | BD-E01, BD-E02 | must equal `R2` if present |
| Property type | `general.propertyTypeDetail` (then `propertyType`, `landUse`) | BD-E04 (populated on 500/500 rows) | **no default** |
| Owner name | `owner.fullName`, `owner.names[0].full` | BD-E06 | first non-empty |
| Owner occupancy | `quickLists.ownerOccupied`, `owner.ownerOccupied` | BD-E06 | first boolean |

---

## 4. `intel.lastSoldDate` vs `sale` — conclusion

- FirstKnock filters on `searchCriteria.intel.lastSoldDate`. That is proven
  (BD-E01, BD-E05) and proven to work with polygon geography (OBS-05).
- Real returned rows carry `intel.lastSoldDate` as an **ISO-8601 UTC midnight
  datetime string** — `"2026-06-23T00:00:00.000Z"` (OBS-01),
  `"2024-05-24T00:00:00.000Z"` (OBS-04) — even though the request bound is
  date-only. The mapper compares calendar dates anchored to the job's own
  reference time, so a midnight instant cannot fall a few hours out of window.
- **`intel.lastSoldDate` is authoritative.** It is the field the request
  filters on, so it is the only field that can prove the user's request was
  honoured.
- A separate `sale` object is documented as a `deed`-dataset structure
  (`sale.lastSale.saleDate`, `deedHistory[].recordingDate`) in BD-E06. It is
  retained as a fallback *below* `intel`, never above it.
- **Unproven:** whether `sale` and `intel.lastSoldDate` can disagree on a real
  row. No capture contains both. Marked as an evidence gap; no behaviour depends
  on resolving it, because `intel` wins whenever present.
- **Unproven:** whether the provider applies `maxDate` to the same returned
  field as `minDate`. FirstKnock revalidates *both* bounds locally, so
  correctness does not depend on the answer.

---

## 5. Local eligibility matrix

| Rule | Sent to BatchData | Returned evidence field | Local recheck | Reason |
|---|---|---|---|---|
| Inside polygon | Yes | coordinates | **Yes** | Prevent provider spillover; row dropped entirely if outside |
| Recorded-sale window | Yes | `intel.lastSoldDate` | **Yes** | Exact request guarantee; `missing_recorded_sale_date` / `recorded_sale_outside_window` |
| Minimum value | Yes | `valuation.estimatedValue` | **Yes** | `unprovable_minimum_value` when a minimum was requested and no value is provable |
| Maximum value | Sibling-inferred | same | **Yes** | `outside_requested_value_range` |
| Land use = R2 | Yes | `general.standardizedLandUseCode` | **Yes** | Rejects a returned code that contradicts the request |
| Single-family | Partially (via R2) | `general.propertyTypeDetail` | **Yes** | `unprovable_property_type`; R2 is proven *residential*, **not** proven *single-family* |
| Coordinates present | Provider returns | address location fields | **Yes** | Required for map routing |
| Listing status | **No** | — | **No** | OBS-06: frequently absent on real rows; cannot be an eligibility input |

**Delivery invariant:** a row counts toward `precision_usage_count` only when it
also survives exact-job candidate retrieval. Proven end-to-end in
`test/batchdata-contract-end-to-end-trace.test.mjs`.

**No-guessing invariant:** no missing provider field is replaced with a value in
order to make a row eligible.

---

## 6. Removed / retained aliases

**Removed (MLS-era, retired pipeline):**

| Removed | Where | Why |
|---|---|---|
| `listing.status` / `listing.statusCategory` reads | `mapBatchDataProperty` | Dead code — assigned, never read. `statusCategory` is documented in BD-E06 as absent from BatchData's public schema. |
| `p.listing.soldDate` as the first sale-date fallback | `mapBatchDataProperty` | An MLS sold date is not an ownership transfer; BD-E06 records a 30–60 day MLS-to-deed gap. |
| `listing.price`, `listing.listPrice` in the value chain | `mapBatchDataProperty` | A list price is not an estimated value; the outbound filter is `valuation.estimatedValue`. |
| `providerPropertyType \|\| 'Single Family'` | `mapBatchDataProperty` | Fabricated a provider value. Precision now persists `null` and excludes the row. |
| `[batch].filter(Boolean)` object-wrapping | `extractBatchDataRecords` | Turned any unrecognised envelope into one fabricated record. |
| `include_mls` in the browser retry payload | `TerritoryPrompt.jsx` | Not part of the Precision request and not in `MATERIAL_CRITERIA_FIELDS`. |

**Retained deliberately:**

| Retained | Evidence | Note |
|---|---|---|
| `address.location.*` **and** `address.*` coordinates | none | Both unproven; removing either risks breaking routing. Pinned by paired fixtures. |
| `payload.properties`, `payload.results` envelopes | none | No capture rules them out; now array-only so they cannot fabricate a row. |
| `sale.*` / `deedHistory[]` date fallbacks | BD-E06 | Below `intel`, never above. |
| `include_mls: false` on the FetchJob entity | — | Inert legacy metadata. Removing is a migration risk; it influences nothing (proven by `test/batchdata-contract-mls-removal.test.mjs`). |

---

## 7. Evidence gaps — require a separately authorized sandbox capture

No paid provider call was made during this work. The following need one:

1. **Coordinate nesting** — `address.location.latitude` vs `address.latitude`.
   Highest priority: coordinates are required for routing.
2. **Total record count** — none of `results.totalRecordCount`,
   `totalRecordCount`, `meta.totalRecordCount` is proven. Paging currently
   terminates on a short page.
3. **`sale` vs `intel.lastSoldDate` disagreement** on a real row.
4. **`maxDate` semantics** — whether the provider applies it to the same
   returned field as `minDate`.
5. **Full raw response body** for a Precision polygon call, to convert
   `reconstructed_response` fixtures into real captures.
6. **`general` nesting** of `propertyTypeDetail` and the response-side path of
   `standardizedLandUseCode`.

### Capture plan (needs separate authorization)

Run `validateBatchDataShape` (admin-only, no-write, sandbox key by default)
against a small polygon with `options.take: 5` and **no** `options.datasets`.
Persist the full raw body, redact owner names and street addresses with the
deterministic tokens used in this corpus, and promote it to
`source_type: real_provider_capture` in `test/fixtures/batchdata/manifest.json`.
The replay tests will then run against a real body with no test changes.
