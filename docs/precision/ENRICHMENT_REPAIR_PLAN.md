# Precision enrichment — defect, fix, and route repair plan

## 1. The defect

`buildBatchDataRequest` in `base44/functions/processFetchChunk/entry.ts` scoped the
provider response:

```js
options: { skip, take, datasets: ['basic', 'deed', 'owner'] }
```

The same request filters on `searchCriteria.intel.lastSoldDate`, and the mapper
treats `intel` as the authoritative source for recorded sale date, estimated
value, year built and living area.

**`intel` is not a member of `basic | listing | deed | owner`.** No datasets
array can include it. The request therefore scoped away the object it filters on
and maps from. This contradiction is visible in the source itself and needs no
provider capture to establish.

PR #66 reached the same conclusion independently from a live no-write A/B probe
(evidence **BD-E02**, recorded in `src/tasks/todo.md`): scoping datasets made
BatchData omit the `intel` and `sale` objects, while the same polygon unscoped
returned them. Note the honest limit of that evidence — the raw response body
was **not retained**, so BD-E02 is a record of observed field facts, not a
replayable capture. The structural argument above does not depend on it.

### Why the export looked healthy

The local gates were deliberately loosened and do **not** reject incomplete
rows; the price gate explicitly passes unknown-price records. So a shell row
persists and reaches a route with:

| Field | Source object | Result when scoped |
|---|---|---|
| address, coordinates | `address` (basic) | present |
| owner name | `owner` | present |
| sold date | `intel.lastSoldDate`, `sale.*` | **null** |
| price / value | `valuation`, `intel`, `sale` | **null** |
| beds, baths | `building` | **null** |
| sqft | `intel`, `building` | **null** |
| lot size | `lot` | **null** |
| year built | `intel`, `building` | **null** |

Two display fields make this harder to spot, and **neither is evidence of
enrichment**:

- `property_type` falls back to the literal `'Single Family'` when the provider
  supplies no type at all.
- `sale_type` is the hard-coded constant `'BatchData'` — a data-source label,
  not proof a sale record existed.

Both are pinned by `ENRICH-08`.

### The same defect has a second, louder symptom

Whether a shell row survives depends entirely on the sold-date range mode:

```js
isInCustomOwnershipRange = !bounds || (hasValidSaleDate && saleDate >= oldest && saleDate <= newest)
route_active             = !rejected && isInCustomOwnershipRange
```

| Sold-date range | Record | `route_active` | Presentation |
|---|---|---|---|
| **Quick** | shell | `true` | route silently fills with null-enrichment homes |
| **Quick** | enriched | `true` | correct |
| **Custom** | shell | **`false`** | *"0 qualifying homes from N provider records"* |
| **Custom** | enriched | `true` | correct |

With a quick range there are no bounds, so the expression is vacuously true and
the shell passes. With a **custom** range it requires a valid recorded sale
date — which the suppressed `intel` object never supplied — so **every** record
is rejected and the pull reports zero qualifying homes despite the provider
returning records.

A report of *"we checked N provider records, found 0 qualifying"* under a custom
range is therefore the loud form of the same defect, not a separate bug, and not
a too-narrow polygon or too-strict filter. Pinned by `ENRICH-14`, `ENRICH-15`
and `ENRICH-16`.

This also means the user-facing guidance in that case — *"draw a larger area,
widen the sold-date range, loosen the value range"* — was misleading. No
parameter change could have helped, because no returned record could carry a
sale date.

## 2. The fix

`options` is now exactly `{ skip, take }`. Preserved unchanged: polygon and its
closure, `intel.lastSoldDate` min/max bounds, `valuation.estimatedValue` bounds,
the `standardizedLandUseCode = R2` filter, pagination, `take <= 100`, and retry
behaviour. The parser was **not** redesigned.

## 3. Why one property of ten was complete

Property persistence preserves existing non-null values:

```sql
beds = COALESCE(${p.beds || null}, beds)
```

A new shell response cannot erase enrichment already stored. So a property
enriched by an earlier pull or hydration keeps its values, while newly inserted
properties are written with the nulls the shell response carried.

```
9 newly inserted shell records
+ 1 previously enriched existing record
= 1 of 10 apparently hydrated
```

**This remains an inference until the queries in §4 are run.** It is consistent
with both the export and the persistence logic, and `ENRICH-06`/`ENRICH-09`
demonstrate both halves of the mechanism, but the specific claim about 725
Parkins Mill Rd is unverified.

## 4. Read-only diagnostics

> **Not authorized to run.** These are read-only `SELECT`s, provided for a
> separate, explicitly authorized diagnostic session. No statement here mutates
> data. Substitute the real identifiers before running.

Note the storage split: `properties` and `workspace_properties` are Postgres
tables, but **`FetchJob` and `SavedRoute` are Base44 entities, not SQL tables.**
Steps 1 and 2 must go through the entity API; only steps 3–5 are SQL.

**Step 1 — identify the route and job (Base44 entity API, read-only).**
Locate the `SavedRoute` named for the Greenville Precision route, then read its
`fetch_job_id` and the `FetchJob`'s `batchdata_summary`. On jobs created after
this fix, `batchdata_summary.enrichment` answers the question directly.

**Step 2 — read the job's property set.** Take the route's address hashes from
the `SavedRoute` payload.

**Step 3 — enrichment completeness for those properties.**

```sql
SELECT
    p.address_hash,
    p.full_address,
    (p.price      IS NOT NULL) AS has_value,
    (p.beds       IS NOT NULL) AS has_beds,
    (p.baths      IS NOT NULL) AS has_baths,
    (p.sqft       IS NOT NULL) AS has_sqft,
    (p.lot_size   IS NOT NULL) AS has_lot_size,
    (p.year_built IS NOT NULL) AS has_year_built,
    (p.sold_date  IS NOT NULL) AS has_sold_date,
    p.data_source,
    p.updated_at
FROM properties p
WHERE p.address_hash = ANY($1::text[])
ORDER BY has_sold_date DESC, p.full_address;
```

**Step 4 — did the complete row predate this job?** This is the test of the §3
inference. If `wp.fetch_job_id` differs from the job under investigation, or
`p.updated_at` predates it, the row was enriched earlier.

```sql
SELECT
    p.address_hash,
    p.full_address,
    p.updated_at        AS property_updated_at,
    wp.fetch_job_id,
    wp.updated_at       AS workspace_updated_at
FROM properties p
JOIN workspace_properties wp ON wp.property_id = p.id
WHERE p.address_hash = ANY($1::text[])
  AND wp.user_email = $2
ORDER BY p.updated_at;
```

**Step 5 — population rate across the affected window.** Confirms whether this
is route-specific or fleet-wide before deciding the blast radius.

```sql
SELECT
    date_trunc('day', p.updated_at) AS day,
    COUNT(*)                                                  AS properties,
    COUNT(*) FILTER (WHERE p.sold_date  IS NOT NULL)          AS with_sold_date,
    COUNT(*) FILTER (WHERE p.price      IS NOT NULL)          AS with_value,
    COUNT(*) FILTER (WHERE p.year_built IS NOT NULL)          AS with_year_built,
    COUNT(*) FILTER (WHERE p.beds       IS NOT NULL)          AS with_beds
FROM properties p
WHERE p.data_source = 'batchdata'
  AND p.updated_at >= $1
GROUP BY 1
ORDER BY 1;
```

## 5. Repair procedure for the existing route

> **Not executed here.** No provider call and no mutation was performed. This
> requires separate authorization.

The missing fields were never persisted, and `raw_payload` is minimized, so they
cannot be recovered locally. A new provider request is required.

1. Run §4 and confirm which of the ten rows are actually incomplete.
2. Re-issue the **original** polygon and criteria with `datasets` omitted, using
   the corrected builder. Dry-run first, writing nothing.
3. Match returned records to persisted rows by `address_hash` (`ENRICH-10`
   pins that shell and enriched records of the same address hash agree).
4. Update **only** fields that are currently null. Never overwrite a non-null
   value — the existing `COALESCE` semantics already express this.
5. Preserve route membership and ordering. Do not regenerate the route.
6. **Do not charge the user's Precision allowance twice.** This is a remediation
   of a defect, not a new pull.
7. Record BatchData API credit consumption separately from user allowance.
8. Re-export the CSV and confirm 10/10 before closing.

Do not repeatedly regenerate the route in the meantime — each run may consume
provider credits without changing the outcome.

## 6. Canary before broad rollout

One controlled 10-home pull should confirm, against the real provider, that the
unscoped request returns `intel` and `sale`. Compare raw returned fields to
persisted fields. **No provider call is authorized in this work order**, so this
step is deliberately outstanding — the fix is justified by the structural
argument in §1, and the canary converts that into direct evidence.

`batchdata_summary.enrichment` was added for exactly this purpose:

```
provider_records_returned
records_with_recorded_sale_date     records_missing_recorded_sale_date
records_with_estimated_value        records_missing_estimated_value
records_with_year_built
records_with_beds / baths / sqft / lot_size
```

Counts only — no payloads, no addresses, no owner names (`ENRICH-13`).

## 7. Scope

Changed: the `options` object, plus `summarizeEnrichment` and its one call site.

Not changed: order control (PR #74), active-job behaviour, allowance, candidate
retrieval, route optimization, SavedRoute behaviour, retry architecture, the
response parser, and the frontend. PR #66 was not modified or merged.
