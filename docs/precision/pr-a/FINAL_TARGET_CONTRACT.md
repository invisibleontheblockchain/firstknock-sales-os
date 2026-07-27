# Final Target Contract — Stages 0–4

Authoritative for PR A. Where a clause is unresolved it says so; nothing is
invented to make implementation convenient.

## Stage 0 — identity, workspace, entitlement, allowance

| # | Clause | Status |
|---|---|---|
| 0.1 | One authenticated actor, from the session. No request field influences identity. | already held — **KEEP** |
| 0.2 | One immutable usage subject. Email is a fallback **only** for rows with no subject. | **implemented** (CH-01) |
| 0.3 | One workspace, server-derived as `team_manager_id \|\| id`, recording authorization scope only. Usage attribution unchanged. | **implemented** (CH-06) |
| 0.4 | One entitlement decision, from Stripe evidence or an id-keyed grant. | partly — the email-keyed grant is unresolved |
| 0.5 | One allowance decision, computed inside the usage lock. | already held — **KEEP** |
| 0.6 | Every gate fails closed and is re-checked under the lock. | already held — **KEEP** |
| 0.7 | The browser may display the allowance; it may never cap or gate on it. | **implemented for Max Available** (CH-04); Fixed Count unresolved |

**Unresolved.** The hard-coded email grant (`F-PRA-002`) is a production bypass
keyed on a mutable attribute. It cannot be removed without that account's
immutable id, and removing it blind would revoke a live entitlement.
`PRODUCT_DECISION_REQUIRED`. The remediation is to add that account to
`BETA_ACCESS_GRANTS`, which is already validated correctly and keyed on the
immutable id, then delete the email branch.

## Stage 1 — canonical polygon

| # | Clause | Status |
|---|---|---|
| 1.1 | Vertices conserved verbatim — no closure, dedupe, rewinding or reordering. | **KEEP** |
| 1.2 | Coordinates numeric and within `-90..90` / `-180..180`. | **implemented** (CH-02) |
| 1.3 | A malformed vertex is reported with its index, never silently dropped. | **implemented** (CH-02) |
| 1.4 | Duplicate points, self-intersection and either winding remain accepted. | **KEEP** |
| 1.5 | Hash: 6-dp rounding, submitted order, SHA-256, first 16 hex. Unchanged. | **KEEP** |
| 1.6 | Centroid: vertex mean. Unchanged in this PR. | **DOCUMENT** |
| 1.7 | Area: shoelace on an equirectangular projection, ring closed implicitly. | **KEEP** |

**Unresolved.** Whether `polygon_hash` identifies a *submission* or an *area*
(`F-PRA-010`). Changing it would break every resume, retry and exact-candidate
lookup, so it is left alone. `PRODUCT_DECISION_REQUIRED`.

## Stage 2 — order and criteria

| # | Clause | Status |
|---|---|---|
| 2.1 | `requested_properties` absent → the plan maximum. `''` counts as absent. | **KEEP** |
| 2.2 | Present but not a positive integer → `400 invalid_requested_properties`. | **implemented** (CH-03) |
| 2.3 | `count_mode: max_available` → `effective_count` is the allowance inside the lock; the submitted number is ignored. | **implemented** (CH-04) |
| 2.4 | `count_mode: fixed` → `min(entered, locked remaining)`, capping disclosed. | **KEEP** |
| 2.5 | Reservations are always whole numbers. | **implemented** (CH-03) |
| 2.6 | Route filters server-forced; the client cannot widen them. | **KEEP** |
| 2.7 | Route bounds carry coordinates only and never reach provider-selection criteria. | **KEEP** |
| 2.8 | The full custom window — minimum **and** maximum — is first-class in the criteria snapshot, not only derivable from `sold_months`. | **implemented** (CH-06) |
| 2.9 | Quick ranges of one month or less require Pro, re-checked under the lock. | **KEEP** |
| 2.10 | Both start paths persist the identical criteria set. | **implemented** (CH-06) |

**Unresolved.** `entered_count` semantics for Fixed Count — Contract A vs B
(`ADJ-M2-009`) — and the `min_price` default divergence, which is owned by
PR #66. PR A assumes neither.

## Stage 3 — Preview

| # | Clause | Status |
|---|---|---|
| 3.1 | A provider failure degrades Preview; it never fails it. | **implemented** (CH-07) |
| 3.2 | The probe has a timeout. | **implemented** (CH-07) — 8s |
| 3.3 | Preview never states an availability it did not measure. | **implemented** (CH-07) via `availability_measured: false` |
| 3.4 | Preview fails closed on an unavailable allowance. | **KEEP** |
| 3.5 | Preview creates no FetchJob, no reservation, and takes no lock. | **KEEP** |
| 3.6 | Preview's provider interaction is disclosed for what it is. | **implemented** (CH-07) via `sandbox_probe_meaning` |

**Preview's role, as characterized:** an allowance-and-cost estimator with a
provider reachability probe. It is **not** geometry validation (the polygon is
never sent), **not** an availability estimate, and **not** a property preview.

**Unresolved.** What Preview should promise (`F-PRA-032`); whether the sandbox
key is billable (`F-PRA-060`, `EXTERNALLY_BLOCKED`); `getPrecisionUsage`'s writes
(`F-PRA-034`, deferred with reasoning in `ADJ-M2-008`).

## Stage 4 — lock, active jobs, reservation, canonical FetchJob

```
authenticate → immutable subject → workspace → entitlement
  → validate canonical polygon → validate canonical criteria
  ── usage lock ────────────────────────────────────────────
     → active-job decision { zero | one_exact_match | one_conflict | multiple_active }
     → settled usage + reservations → remaining allowance
     → effective target
     → ONE reservation, fused into ONE canonical FetchJob
  ── unlock ────────────────────────────────────────────────
  → ONE processor invocation → return the exact job
```

| # | Clause | Status |
|---|---|---|
| 4.1 | Active-job lookup queries both keys and verifies ownership by immutable subject. | **implemented** (CH-05) |
| 4.2 | Deterministic ordering; four named outcomes; extras never silently ignored. | **implemented** (CH-05) |
| 4.3 | Resume only on an exact criteria match. | **implemented** (CH-05) |
| 4.4 | A legacy job is compared only on the fields it can prove. | **implemented** (CH-05) |
| 4.5 | A client flag is never authority to destroy server-owned work. | **implemented** (CH-05) |
| 4.6 | Age-based cancellation applies only to a conflicting job. | **implemented** (CH-05) |
| 4.7 | Reservation and FetchJob remain **one write**. | **KEEP** |
| 4.8 | Both endpoints contend on one per-subject lock key. | **KEEP** |
| 4.9 | Every job carries workspace, both versions, and a snapshot when publishable. | **implemented** (CH-06) |
| 4.10 | Settlement stays the processor's sole responsibility. | **KEEP** |

**Criteria equivalence is defined explicitly.** Two orders are the same when all
18 `MATERIAL_CRITERIA_FIELDS` match by JSON equality — or, for a job with no
snapshot, the 9 `LEGACY_COMPARABLE_CRITERIA_FIELDS` it can prove.

**Unresolved.** Reservation release when the server cancels a job (`F-PRA-040`),
deferred rather than introducing a second writable truth.
