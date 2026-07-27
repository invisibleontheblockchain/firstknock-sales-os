# Change Ledger — PR A

Every production change, its adjudication, and why its scope is sufficient.
No change exists without an adjudicated finding.

Files touched: `base44/functions/_shared/precisionOrderContract.js` (new),
`base44/functions/startBatchDataPull/entry.ts`,
`base44/functions/fetchAreaProperties/entry.ts`,
`base44/functions/previewBatchDataArea/entry.ts`.
**No frontend file was modified.** No file outside Stages 0–4 was modified.

---

## CH-01 — Ownership-scoped allowance attribution

**Adjudication** `ADJ-M2-001` · **Model 1** `F-PRA-003` · **Stage** 0 · **C0**
**Functions** `getPrecisionJobs` (both paths), `precisionJobBelongsToSubject`, `selectPrecisionJobsForSubject`

**Before.** The email query's rows were merged into the allowance set unfiltered.
**After.** The email query still runs — rows predating `precision_usage_user_id`
can only be found that way — but results are ownership-filtered.

**Why this scope is sufficient.** It closes cross-subject attribution without
dropping legacy rows, which would *under*-bill. **Why broader was rejected:**
removing the email query entirely (Model 1 listed it as an alternative) would
silently stop counting genuine legacy usage.

**Expected unchanged.** Own-subject and legacy email-only attribution
(`ADJ-M2-001` pins both). **Compatibility:** no schema change; PR #66 already
applies the same rule.

---

## CH-02 — Polygon coordinate validation

**Adjudication** `ADJ-M2-002` · **Model 1** `F-PRA-008`, `F-PRA-009`, `F-PRA-012` · **Stage** 1 · **C0**
**Functions** `normalizePrecisionPolygon`

**Before.** No range check; malformed vertices silently dropped.
**After.** `-90..90` / `-180..180` enforced; a bad vertex returns
`invalid_polygon_point` with its index.

**Why this scope is sufficient.** It reuses the bounds `normalizeRoutePoint`
already applies in the same file. **Why broader was rejected:** the area-centroid
change (`F-PRA-011`) would move the county-resolution point on new jobs with no
demonstrated harm behind it.

**Expected unchanged.** Vertex conservation, hashing, winding, duplicates,
self-intersection, boundary coordinates — seven shapes pinned by `ADJ-M2-002`.

---

## CH-03 — Explicit count validation

**Adjudication** `ADJ-M2-003` · **Model 1** `F-PRA-016`, `F-PRA-017` · **Stage** 2 · **C0**
**Functions** `normalizeRequestedCount`

**Before.** `0`/negatives/decimals/non-numerics silently meant "max available";
`25.7` produced a fractional reservation.
**After.** Absent still means the plan maximum; present-but-unusable returns
`invalid_requested_properties`.

**Why this scope is sufficient.** It distinguishes *absent* from *invalid*, which
is the actual defect. **Why broader was rejected:** Model 1 would also reject
`''`; Model 2 keeps it meaning absent (standard form semantics, and prior
behaviour).

**Compatibility.** A client sending `0` today gets a max-available pull; after
this it gets a 400. Client audit recommended before release.

---

## CH-04 — Server-authoritative Max Available

**Adjudication** `ADJ-M2-004` · **Model 1** `F-PRA-018` · **Stage** 2 · **C1**
**Functions** `resolveEffectiveCount`

**Before.** `count_mode` performed no arithmetic; the browser's snapshot was the
ceiling.
**After.** `max_available` resolves to the allowance observed inside the lock;
`fixed` is unchanged.

**Why this scope is sufficient.** It makes the label true without touching Fixed
Count, whose meaning is an unresolved product decision (`ADJ-M2-009`).

**Compatibility.** Users receive more homes when the allowance grew — bounded by
the locked allowance, so the cap is never exceeded. Needs release-note
disclosure.

---

## CH-05 — Criteria-aware active-job decision

**Adjudication** `ADJ-M2-005`, `ADJ-M2-006` · **Model 1** `F-PRA-036`–`F-PRA-041` · **Stage** 4 · **C1**
**Functions** `classifyActivePrecisionJobs`, `existingPrecisionCriteria`, `comparePrecisionCriteria`

**Before.** Resume without comparing criteria; email-keyed, unsorted, index-0
lookup; no ownership re-verification; a client flag destroyed healthy jobs.
**After.** Both keys queried, ownership verified, deterministic ordering, four
explicit outcomes. Only `one_exact_match` resumes. The client-flag cancellation
is removed; age-based cancellation applies only to a conflicting job.

**Why this scope is sufficient.** It fixes the silent C0 replacement and the
authority hole together, because they share one code path.
**Why broader was rejected:** removing age-based cancellation entirely leaves
users blocked for 30 minutes with no in-app remedy.

**Legacy safety.** A job with no criteria snapshot is compared only on
`LEGACY_COMPARABLE_CRITERIA_FIELDS`. Without this, every in-flight job at deploy
time would 409 — reinterpreting old jobs under new semantics.

---

## CH-06 — Canonical FetchJob: workspace, versions, criteria snapshot

**Adjudication** `ADJ-M2-007` · **Model 1** `F-PRA-004`, `F-PRA-026`, `F-PRA-046`, `F-PRA-047`, `F-PRA-049` · **Stage** 4 · **C1**

**Before.** No workspace, no versions, no snapshot; `fetchAreaProperties`
discarded four repull fields.
**After.** `workspace_id` (server-derived, never from the body),
`criteria_schema_version`, `provider_contract_version`, and the snapshot when it
is publishable. Repull fields persisted on both paths.

**Why this scope is sufficient.** It removes downstream reconstruction without
changing usage attribution — still `precision_usage_user_id`, pinned by
`ADJ-M2-007`.

**`M2-NEW-01`.** The snapshot is withheld when the criteria cannot satisfy
PR #66's schema-v1 rules (currently only a null `min_price`), with
`precision_criteria_withheld` recording why. Publishing an unsatisfiable snapshot
would flip an accepted job into a rejected one.

---

## CH-07 — Preview provider containment and disclosure

**Adjudication** `ADJ-M2-008` · **Model 1** `F-PRA-031`, `F-PRA-033` · **Stage** 3

**Before.** No timeout; a transport failure returned 500 and destroyed a Preview
whose other results were valid. A zero-record probe still reported eligibility.
**After.** 8s timeout, contained failure (`sandbox_probe_error`), plus
`availability_measured: false` and `sandbox_probe_meaning`.

**Why this scope is sufficient.** It fixes availability and truthfulness without
touching what is sent to the provider — that is Stage 6 and could alter cost in
an unmeasured direction.

**NOT changed.** The probe still runs on every Preview when the key is set.
Whether it is billable is `EXTERNALLY_BLOCKED`.

---

## Test-infrastructure change

`test/precision-pull-cap.test.mjs` — its `vm` sandbox strips imports, so the new
shared module is evaluated and supplied as globals. **The real production module
is used, not a stub.** Required because the handlers now import it.

## Behaviour deliberately NOT changed

Single-write reservation · shared advisory lock · entitlement and allowance
re-derived inside the lock · polygon hashing · server-forced route filters ·
route-bounds privacy · quick-range Pro gating · `min_price` default divergence ·
hard-coded email grant · reservation release on cancellation · Preview's
`getPrecisionUsage` writes · the area centroid · all of Stages 5–11.
