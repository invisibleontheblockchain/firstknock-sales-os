# FirstKnock Precision — End-to-End Control Map

This is the canonical description of what Precision generation must do.
For what it *currently* does, see [`PR66_STAGE_STATUS.md`](./PR66_STAGE_STATUS.md).

**Current implementation** and **target invariant** are marked separately
throughout. Never read a target as a claim about today's code.

---

## 1. The core product promise

> The exact route the user requests must remain the exact request sent to
> BatchData, the exact criteria used to accept properties, the exact FetchJob
> used to retrieve candidates, and the exact provenance stored with the
> finished route.

Authority chain:

```
Authenticated user
→ captured user intent
→ canonical server criteria
→ locked allowance and reservation decision
→ exact FetchJob
→ exact BatchData request
→ actual BatchData response
→ evidence-backed property parsing
→ exact delivered property set
→ exact candidate set
→ route filtering and optimization
→ SavedRoute with complete provenance
```

No stage may silently change the order, apply an undisclosed default, substitute
an older job, mix properties from another request, count properties that cannot
be routed, drop properties without a named reason, guess what a BatchData field
means, or use browser state as proof of server authority.

---

## 2. The seven planes

| Plane | Responsibility | Primary code |
|---|---|---|
| **A. Order** | Capture what the user requested | `src/components/map/TerritoryPrompt.jsx`, `PrecisionPullPanel.jsx` |
| **B. Control** | Authenticate, validate, reserve allowance, create the FetchJob | `startBatchDataPull`, `fetchAreaProperties`, `_shared/precisionActiveJobCriteria.js` |
| **C. Provider** | Build the BatchData request, receive the real response | `processFetchChunk` (`buildBatchDataRequest`, `fetchBatchDataRecords`) |
| **D. Interpretation** | Parse and classify actual BatchData objects | `processFetchChunk` (`extractBatchDataRecords`, `mapBatchDataProperty`) |
| **E. Persistence** | Store properties, associations, eligibility, usage | `processFetchChunk` (`writePropertiesToNeon`) |
| **F. Route** | Exact candidates → filters → optimize → save | `getRouteCandidatesFromNeon`, `generateRoutesBackend`, `src/pages/Home.jsx` |
| **G. Recovery & Audit** | Retry, reload, history, provenance, CI, diagnostics | `fetchJobStatus`, `cancelFetchJob`, `PolygonHistory.jsx` |

**Target invariant:** every function and DB field in the Precision flow belongs
to exactly one plane, and a business rule has exactly one authoritative
implementation.

**Current implementation:** violated in three known places — see §9.

---

## 3. Master pipeline map

```
STAGE 0  — Identity and entitlement
STAGE 1  — Freehand polygon
STAGE 2  — User configures the Precision order
STAGE 3  — Optional provider preview
STAGE 4  — Server validates and locks the request
STAGE 5  — Exact FetchJob and canonical criteria created
STAGE 6  — Exact BatchData request constructed
STAGE 7  — Actual BatchData response received
STAGE 8  — Response parsed and each property classified
STAGE 9  — Properties persisted and usage settled
STAGE 10 — Completion status reaches the browser
STAGE 11 — Exact FetchJob candidates retrieved
STAGE 12 — Properties filtered and routes optimized
STAGE 13 — Routes saved with complete provenance
STAGE 14 — Route displayed and assigned
```

Alternate paths must rejoin the same chain:

```
Retry ───────────────┐
Browser reload ──────┼→ verified FetchJob → exact candidates → route
History restoration ─┘
```

They must never construct a second, weaker authority path.

---

## 4. Stage detail

### Stage 0 — Identity, workspace, plan, allowance · Plane B

Determine who is asking, which immutable usage user owns it, which workspace,
which plan, whether Pro applies, and how many properties remain.

Outputs: `actor_user_id`, `subject_user_id`, `workspace_id`, `entitlement_kind`,
`paid_access`, `pro_access`, `usage_limit`, `used_count`, `reserved_count`,
`remaining_count`.

**Target invariant:** all server-derived. The browser may display these but may
never authorize itself by sending email, user ID, workspace ID, admin role, or
allowance count.

---

### Stage 1 — Freehand polygon capture · Plane A

Normalization requirements: ≥3 distinct points, valid coordinate ranges,
consistent coordinate order, deterministic closure, deterministic rounding,
deterministic hash.

Outputs: `normalized_polygon`, `polygon_hash`, `area_sq_mi`, `centroid`,
county/FIPS.

**Target invariant:** one normalization algorithm shared by the initial request,
FetchJob persistence, active-job comparison, retry verification, candidate
retrieval, history restoration, and route generation. No property outside the
exact polygon may enter the delivered candidate set.

---

### Stage 2 — User configures the order · Plane A

#### Count model — four independent counts

```
entered_count             1,000   what the user asked for
effective_count             839   what the locked server allowed
delivered_count             612   persisted route-active and billed
saved_route_property_count  600   what ended up in SavedRoutes
```

Required relationship:

```
saved_route_property_count ≤ delivered_count ≤ effective_count ≤ entered_count
```

- **Fixed Count** — `effective_count = min(entered_count, allowance, plan cap)`.
  **Target invariant:** the browser must preserve `1,000` as intent even when the
  displayed allowance is `839`. It must not pre-cap before the server sees it.
- **Max Available** — the *mode* is the intent. `effective_count` is the allowance
  measured **inside the usage lock**. A browser allowance snapshot is not the
  order.

#### Home value range

Blank minimum receives a disclosed server default of `$100,000`
(`DEFAULT_PRECISION_MIN_PRICE`).

**Target invariant:** the disclosed interpretation stays identical across UI →
canonical criteria → BatchData request → parser eligibility → candidate
verification → SavedRoute metadata.

Estimated value, assessed value, sale amount, and listing price are **not**
interchangeable. Precedence must come from an explicit product rule plus real
provider evidence.

#### Homes sold in the last

| UI choice | `sold_months` | Days |
|---|---|---|
| 1 day | 1/30 | 1 |
| 2 days | 2/30 | 2 |
| 1 week | 0.25 | 7 |
| 2 weeks | 0.5 | 14 |
| 1 month | 1 | 30 |
| 3 months | 3 | 90 |
| 6 months | 6 | 180 |
| 12 months | 12 | 365 |

Shorter windows require Pro. Custom recorded-sale age is 1–365 days:
`minDate` carries the **oldest** allowed date (max days ago), `maxDate` the
**newest** (min days ago).

Date cutoffs anchor to the job's own `created_date`, never a rolling
`Date.now()`. A real job once lost every row because midnight-UTC sale dates
were compared against `now - 7*24h`.

**Max Since Last** spans `previous_pull_date → now`. It must never be silently
converted into a standard 12-month pull.

#### Route from home and back

This is **route geometry, not a property filter**.

```
Off:                route_bounds.enabled = false
Home round trip:    mode = home_round_trip,  start = end = Home Base
Current to home:    mode = current_to_home,  start = GPS, end = Home Base
```

Only coordinates may be attached to the Precision request. The private Home Base
address must not be copied into FetchJob logs or shared routes.

---

### Stage 3 — Optional preview · Planes A/C

**Target invariant:** the preview is explicitly non-authoritative. It must not
reserve allowance, create a production FetchJob, promise the final count, replace
the locked allowance calculation, use a different polygon interpretation, or
present unsupported provider fields as facts.

**Current implementation:** `previewBatchDataArea` calls the live BatchData
property-search endpoint. It is non-authoritative but **not free**.

---

### Stage 4 — Locked server start decision · Plane B

```
Authenticate
→ validate polygon
→ resolve entitlement
→ acquire immutable-user usage lock
→ recalculate allowance
→ inspect active jobs
→ inspect unsettled reservations
→ calculate effective count
→ construct canonical criteria
→ create FetchJob
```

**Target invariant:** no provider request begins before the user is
authenticated, exact criteria are persisted, allowance is calculated inside the
lock, the reservation exists, and active-job ambiguity is resolved to
*zero, one, or explicitly-multiple*.

---

### Stage 5 — Exact FetchJob ticket · Planes B/G

The FetchJob is the official order ticket. It must carry: FetchJob ID, immutable
usage user ID, workspace ID, criteria schema version, **provider contract
version**, polygon, polygon hash, count mode, entered count, effective count,
min/max value, sold-date window, ownership mode and range, route filters, route
bounds, repull mode, previous pull date, attempt provenance, reservation.

**Target invariant:** written before provider processing begins; every later
operation refers to this exact FetchJob ID.

---

### Stage 6 — Build the exact BatchData request · Plane C

> **Corrected — supersedes any earlier description.** Earlier versions of this
> map stated the builder sends `options.datasets`. **That is historical
> behavior and is now prohibited.** See [`../BATCHDATA_PRECISION_CONTRACT.md`](../BATCHDATA_PRECISION_CONTRACT.md).

#### Historical behavior (no longer valid)

```
options.skip
options.take
options.datasets        ← previously sent: ['basic','listing','deed','owner'],
                          later ['basic','deed','owner']
```

A live no-write A/B probe on a single polygon (assertion `OBS-02`) proved that
scoping datasets made BatchData **omit the `intel` and `sale` objects**, driving
the job to `active=0`. The unscoped request on the same polygon returned rows
with `intel`/`sale` present. `intel` is not a member of
`basic|listing|deed|owner`, so **no** datasets array can carry the field this
request filters on.

#### Current contract — provider contract version 1

```
searchCriteria
  address.geoLocationPolygon.geoPoints      [{latitude, longitude}], explicitly closed
  intel.lastSoldDate
    minDate                                 YYYY-MM-DD, oldest allowed
    maxDate                                 conditional, custom range only
  general.standardizedLandUseCode.equals    "R2"
  valuation.estimatedValue
    min                                     conditional
    max                                     conditional
options
  skip
  take                                      ≤ 100 (provider-enforced, OBS-03)
```

**`options.datasets` is never sent.**

**Target invariant:** every emitted path traces to a real captured request. A
test must fail when an unsupported field appears.

---

### Stage 7 — Receive the real BatchData response · Plane C

Fixture requirements: preserve object nesting, arrays, nulls, missing fields,
original data types, and real provider field names. Record fixture ID, capture
date, request fixture, response fixture, redactions, endpoint, and what the
fixture proves.

A transformed FirstKnock property record is **not** a raw provider fixture.
Synthetic objects may test malformed-input safety but cannot define the contract.

---

### Stage 8 — Parse and classify every property · Plane D

Outputs: provider property ID, normalized address, latitude, longitude,
recorded-sale date, estimated value, sale amount, land-use code, property type,
owner fields, eligibility result, exclusion reason.

**Target taxonomy** — every raw record ends in exactly one state:

```
ACCEPTED · EXCLUDED · UNRESOLVED · MALFORMED · DUPLICATE · ALREADY_ROUTED
```

Every non-accepted result carries a reason code.

**Current implementation** emits a binary `route_active` plus these reasons:

```
missing_recorded_sale_date · recorded_sale_outside_window
unprovable_minimum_value · unprovable_property_type
not_single_family_residential · outside_requested_value_range
outside_requested_ownership_window
```

Records dropped **before** classification (mapper returns `null`) carry **no
reason today**: missing street, missing ZIP, non-finite coordinates, outside
polygon. Those are invisible `C2 → C3` losses.

---

### Stage 9 — Persistence and usage settlement · Plane E

**Target invariant:**

```
delivered_count = FetchJob.precision_usage_count
```

with exactly one writable authority for delivered count.

```
provider_returned_count ≠ delivered_count
```

The provider may return out-of-polygon results, duplicates, unusable records,
previously routed homes, and records that cannot prove eligibility. Only
accepted, persistable, exact-request properties count as delivered.

---

### Stage 10 — Completion reaches the browser · Plane G

**Target invariant:** the browser asks the server *"do I have zero, one, or
multiple active Precision jobs?"* It must not query by email and choose a result
itself.

---

### Stage 11 — Exact FetchJob candidates · Planes B/F

Must verify: completed FetchJob, authenticated owner, workspace, polygon hash,
criteria schema, exact requested criteria, exact FetchJob row association,
route-active status, valid coordinates, recorded-sale window.

**Target invariant:** a completed Precision route never appends account-wide
properties, ZIP-wide properties, frozen properties from an older route,
candidates from another FetchJob, or locally restored unverified history.

---

### Stage 12 — Route filtering and optimization · Plane F

```
exact candidates → parse coordinates → remove already-assigned
→ apply user route filters → preserve polygon → preserve sale window
→ rank/cap → group streets and subdivisions → apply Home Base start/end
→ optimize → split into routes
```

The optimizer may change property order, grouping, start/end, and estimated
distance. It may **not** change polygon, value range, sold-date range, FetchJob
identity, property eligibility, or delivered usage.

Required metrics: input candidate count, post-filter count, route count,
optimized door count, unrouted count, estimated miles, Home Base legs included,
saved property count.

---

### Stage 13 — SavedRoute provenance · Plane G

Each route must preserve: source FetchJob ID, provider contract version, criteria
schema version, polygon hash, count mode, entered count, effective count,
delivered count, candidate count, optimizer input count, saved count, min/max
value, sold-date window, custom ownership range, route filters, route bounds,
repull mode, previous-pull date, attempt/root job provenance, criteria
verification mode.

**Target invariant:** given a SavedRoute, an operator can answer *"which exact
user request, FetchJob, provider contract, property set, and optimization
settings produced this route?"* without relying on `localStorage`.

---

### Stage 14 — Display and assignment · Plane F

Every SavedRoute property must appear correctly after map hydration and
assignment. Route hydration must find every property the SavedRoute references.

---

## 5. Criteria Conservation Ledger

| Criterion | UI | Canonical | BatchData request | Candidate check | SavedRoute |
|---|---|---|---|---|---|
| Polygon / hash | ✓ | ✓ | ✓ | ✓ | ✓ |
| Count mode | ✓ | ✓ | indirect | ✓ | ✓ |
| Entered count | ✓ | ✓ | pagination target only | ✓ | ✓ |
| Effective count | — | ✓ | pagination target | ✓ | ✓ |
| Minimum value | ✓ | ✓ | ✓ | ✓ | ✓ |
| Maximum value | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sold-date window | ✓ | ✓ | ✓ | ✓ | ✓ |
| Custom age bounds | ✓ | ✓ | ✓ | ✓ | ✓ |
| Single-family rule | ✓ | ✓ | ✓ (R2) | ✓ | ✓ |
| Route bounds | ✓ | ✓ | **never a property filter** | — | ✓ |
| Repull mode | ✓ | ✓ | date behavior | ✓ | ✓ |
| Previous-pull date | ✓ | ✓ | date bounds | ✓ | ✓ |

Report any criterion that changes value, is omitted, receives an undocumented
default, is converted to another meaning, is applied at only one stage, or
appears in the SavedRoute but not in the original order.

---

## 6. Retry, reload, history

**Retry — target:**

```json
{ "retry_fetch_job_id": "source-job-id" }
```

The server loads the original job, verifies actor, workspace, polygon, criteria,
and reservation state, then creates a new attempt. The browser must not
reconstruct the authoritative request from loose fields.

**Reload — target:** the server answers the zero/one/multiple active-job
question.

**History — target:** one complete canonical snapshot is selected. Never merge
count from one job, price from another, and date range from a third. Legacy
history may be displayed but does not become verified merely by existing in
`localStorage`.

---

## 7. Stage rating vocabulary

```
GREEN   — Proven: real evidence and passing behavioral tests
YELLOW  — Partially proven: works in tests, lacks real-provider or full-path evidence
RED     — Demonstrated defect or property loss
GRAY    — Unverified: no sufficient evidence
BLOCKED — Requires external authorization or provider capture
```

A stage is **not** GREEN merely because a unit test passes. A provider-dependent
stage cannot be GREEN without real provider evidence. An end-to-end stage cannot
be GREEN without the relevant conservation handoffs tested.

---

## 8. Definition of done

1. Every user input has one documented meaning.
2. Fixed Count preserves the exact entered intent.
3. Max Available is calculated by the locked server.
4. Every quick and custom sold-date interval maps correctly.
5. Home Base routing affects route geometry, never property eligibility.
6. The exact polygon is used throughout.
7. The outbound request is verified against real request fixtures.
8. The parser is based on real response fixtures.
9. No provider field is guessed.
10. Every property drop has a named reason.
11. Every delivered property survives exact candidate retrieval.
12. Counts reconcile from C0 through C11.
13. Routes contain only properties from the exact FetchJob.
14. SavedRoute carries full provenance, written server-side.
15. Retry, reload, and history rejoin the authoritative path.
16. CI runs the full contract and conservation tests.

---

## 9. Known duplication risks (current implementation)

| Rule | Copies | Status |
|---|---|---|
| `polygonHash` | 4 — `startBatchDataPull`, `fetchAreaProperties`, `previewBatchDataArea`, `getRouteCandidatesFromNeon` | 2 distinct variants. **Hashes agree for well-formed numeric input.** The three writer copies call `p.lat.toFixed()` and throw on string coordinates; the reader copy coerces via `Number()` and returns `null` for invalid input. Should move to `_shared/`. |
| `requestedSoldWindowDays` | 2 — `processFetchChunk`, `getRouteCandidatesFromNeon` | Currently **byte-identical**. If these drift, the request window and the candidate window disagree and properties vanish between C7 and C8. Should move to `_shared/`. |
| Entitlement + allowance | 2 — `startBatchDataPull`, `fetchAreaProperties` | Two independent start paths each with their own `resolvePrecisionEntitlement` / `getPrecisionAllowance` / caps. This is the largest Control-Plane parity risk. |
