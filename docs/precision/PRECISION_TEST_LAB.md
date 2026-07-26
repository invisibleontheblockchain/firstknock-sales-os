# FirstKnock Precision Test Lab

Point A-to-Z pipeline testing and diagnosis. Use this to design a real test run
or to diagnose a live failure. For what each stage must guarantee, see
[`PRECISION_CONTROL_MAP.md`](./PRECISION_CONTROL_MAP.md).

---

## 1. Testing objective

> A user draws a specific polygon, orders homes with specific criteria, and
> receives an optimized route containing as many valid matching homes as
> possible — without criteria changing, properties disappearing without
> explanation, unrelated properties entering the route, or unnecessary BatchData
> credits being consumed.

This is not a "does it work?" test. It must answer:

- Did FirstKnock preserve the user's exact intent?
- Did we send the correct request to BatchData?
- How many BatchData calls and credits were used?
- How many raw homes did BatchData return?
- Why was each home accepted or rejected?
- Where did any missing homes disappear?
- Did the optimizer include all eligible homes?
- Was the route geographically efficient?
- Did the final SavedRoute match the original request one-to-one?

---

## 2. The initial test market

One controlled area:

```
One repeatable freehand polygon
~1 square mile
One known city or neighborhood
One known test account
One known plan and allowance
One exact test date and time
```

Choose an area where recently sold homes can be reviewed manually via public
sources. Build an external reference list:

```
Property address
Publicly shown sold date
Publicly shown sold price or value when available
Source
URL or screenshot
Date the reference was captured
Whether the property is inside the polygon
```

Redfin and Zillow are **comparison references, not provider truth**. Their source
and update timing differ from BatchData. The purpose is to spot obvious gaps:

> "These 14 homes appear publicly sold inside this exact polygon and date range.
> How many did BatchData return, and how many survived FirstKnock?"

---

## 3. The four core pipeline tests

Same polygon, four scenarios.

| Test | Count mode | Entered | Min value | Date range | Proves |
|---|---|---|---|---|---|
| **A** | Fixed Count | 50 | $75,000 | 3 months | A specific numeric request stays intact |
| **B** | Max Available | — | $75,000 | 3 months | Max Available uses the server-authoritative allowance, not a browser count |
| **C** | Fixed Count | 50 | $75,000 | Custom 30–180 days | Both custom date bounds survive UI → FetchJob → BatchData → parsing → candidates → route |
| **D** | Max Available | — | $75,000 | Custom 30–180 days | Max Available and custom windows compose without either changing meaning |

Route from Home Base: Off for all four. Compare B directly against A.

---

## 4. Follow-up — Ghost Mode and repeat spending

```
Original pull → Fill Gaps → Max Since Last → repeat with identical criteria
```

Measure:

- How many homes were already present?
- How many were excluded because they were already routed?
- How many new properties were returned?
- How many BatchData calls were made?
- How many provider records were reviewed?
- Did we pay again for duplicate properties?
- Does Max Since Last narrow the provider request?
- Does Fill Gaps request more data than necessary?
- Are existing route hashes sent, or enforced locally?
- Does a repeated request consume allowance twice?
- Does a failed or empty repeat pull consume credits?

**Do not assume how BatchData charges.** Credit behavior must be measured from
real provider requests, responses, usage reporting, or the commercial contract.

---

## 5. The C0–C11 Property Conservation Ledger

The central mechanism for finding exactly where properties disappear.

| Code | Count |
|---|---|
| `C0` | User entered count / Max Available intent |
| `C1` | Effective server-reserved target |
| `C2` | Raw provider records returned |
| `C3` | Records successfully parsed |
| `C4` | Records passing exact request criteria |
| `C5` | Unique after deduplication |
| `C6` | Not already assigned/routed |
| `C7` | Persisted route-active (delivered) |
| `C8` | Exact FetchJob candidates |
| `C9` | Surviving user route filters |
| `C10` | Doors included by optimizer |
| `C11` | Properties saved across SavedRoutes |

For each transition record `previous_count`, `next_count`, `drop_count`, reason
buckets, sample property IDs, FetchJob ID, criteria schema version, and provider
contract version.

```
C0  User requested              50
C1  Server reserved             50
C2  BatchData returned         112
C3  Parsed successfully        108
      12 missing valid address
       8 invalid coordinates
      10 malformed provider shape
C4  Matched exact criteria      61
     100 outside recorded-sale window
      50 below minimum value
      20 excluded property type
C5  Unique properties           58
C6  Not already routed          52
C7  Delivered                   50
C8  Exact candidates            50
C9  Route-filtered              48
C10 Optimized                   48
C11 Saved                       48
```

### Hard failure condition

```
C8 < C7
```

A property counted as delivered **must** survive exact-job candidate retrieval.
`delivered = 50, exact candidates = 42` is a pipeline integrity failure until the
missing eight are explained.

Reductions after C8 are legitimate but every one needs a visible named reason.

**Current implementation:** this ledger does not exist as a single artifact. It
is the highest-value missing diagnostic. `C2→C3` losses are currently invisible
because the mapper returns `null` without a reason.

---

## 6. The visual testing dashboard

One screen per test run.

**Order panel** — polygon, count mode, entered count, effective count, value
range, date range, route origin, plan and allowance.

**BatchData panel** — sanitized request JSON, request count, pages, take/skip,
raw response count, total provider time, provider credits when measurable.

**Property funnel** — C0 through C11, drop counts, reason buckets.

**Property decision table** — property ID, address token, sold date, value,
classification, accepted/rejected, first failed stage, reason.

**Map layers (toggleable)** — freehand polygon, raw BatchData points,
outside-polygon points, rejected points, accepted points, exact candidates,
optimizer input, final route, Home Base legs.

**Route quality panel** — route count, doors, miles, miles per door, large jumps,
street switches, subdivision switches, path crossings, optimizer duration.

### Route Bounce Score

A route-quality measure built from large jumps between consecutive stops,
returning repeatedly to a previous street, re-entering a subdivision after
leaving it, unnecessary path crossings, and alternating between distant clusters.
The goal is to explain precisely why a route "feels like it bounces around."

---

## 7. Diagnosis rules — always use the first failing stage

| Symptom | Investigate |
|---|---|
| Wrong criteria | Stages 1–4 |
| BatchData returns too few homes | Stage 6 request, Stage 7 response, provider coverage, pagination, credit limits, date/value filtering |
| BatchData returns homes but FirstKnock drops them | Stage 8 parser and eligibility, Stage 9 persistence |
| Delivered count exceeds candidate count | Stage 11 exact candidate retrieval |
| Candidate set correct but route has fewer homes | Stage 12 filters and optimizer, Stage 13 SavedRoute persistence |
| Route has correct homes but bounces around | Stage 12 — street continuity, subdivision continuity, cluster splitting, Home Base geometry |
| Ghost Mode spends too much | Repeat provider requests, existing-route exclusion timing, pagination, duplicate provider records, Fill Gaps construction, Max Since Last date construction |

---

## 8. Success metrics

```
Coverage              = reference sold homes found ÷ reference sold homes in polygon
Provider coverage     = reference sold homes returned by BatchData ÷ reference sold homes in polygon
FirstKnock retention  = valid BatchData homes reaching exact candidates ÷ valid BatchData homes returned
Route retention       = saved route homes ÷ exact candidate homes
Credit efficiency     = provider credits used ÷ delivered valid homes
                      = provider credits used ÷ saved route homes
Duplicate-spend rate  = previously received properties returned again ÷ total raw provider records
Route efficiency      = miles per door, large jumps, street switches, subdivision re-entry, path crossings
```

The goal is **not** simply fewer provider calls. It is the lowest reasonable
provider cost without reducing coverage of valid matching homes.

---

## 9. Minimum test matrix

**Count modes** — Fixed 1 / 20 / 50; Fixed above remaining allowance; Fixed at
paid maximum; Max Available with full, partial, and zero allowance.

**Value ranges** — blank minimum using disclosed default; $75,000 minimum;
minimum only; maximum only; both; equal; maximum below minimum; missing provider
value; multiple real provider value fields.

**Sold-date intervals** — all eight quick options; custom 1–365; custom 30–180;
Max Since Last; date exactly on lower bound; date exactly on upper bound; missing
date; conflicting provider date fields.

**Route origin** — disabled; home round trip; current GPS to Home Base; missing
Home Base; failed geocode; GPS denied; GPS timeout; restored bounds; Home Base
changed before generation.

**Provider response** — each real captured shape; empty; partial; multiple pages;
duplicate property; record outside polygon; missing address; invalid coordinates;
missing qualifying date; missing value; unsupported land-use value; unknown
envelope.

**Recovery** — retry valid failed job; wrong-user retry; wrong-workspace retry;
missing polygon; polygon hash mismatch; multiple active jobs; stale
`localStorage`; browser reload; historical unverified criteria.

---

## 10. Final Point A-to-Z proof

Each run must produce:

```
The user drew this exact polygon.
The user selected Fixed Count or Max Available.
The user selected this exact value range and sold-date range.
The server persisted these exact canonical criteria.
The server calculated this effective count.
This exact request was sent to BatchData.
This number of BatchData requests and pages were used.
This provider usage or credit amount was observed.
BatchData returned this number of raw properties.
These properties were parsed.
These properties were rejected for named reasons.
These properties were delivered and counted.
The exact candidate endpoint returned the same delivered set.
These optional route filters removed these properties.
The optimizer received this exact working set.
The optimizer produced these routes with these quality measurements.
These exact properties were saved.
The finished route matches the original user order.
```

---

## 11. Safety

**Do not make a live or paid BatchData call without separate explicit
authorization.** Both `previewBatchDataArea` and `validateBatchDataShape` reach
the real provider. The deterministic fixture suite
(`npm run test:batchdata-contract`) replays sanitized fixtures and costs nothing.
