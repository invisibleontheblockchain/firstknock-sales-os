# Existing-Job Compatibility — PR A

Old jobs are **not** reinterpreted under new semantics. This was the
highest-risk aspect of PR A and it forced a design change.

## The risk PR A found and closed

Comparing a job created before PR A against the full material criteria set would
have made **every in-flight job at deploy time** look like a conflict: such jobs
predate `workspace_id` and `repull_mode`, so those fields reconstruct as `null`
and mismatch a new order that carries them.

Every user with a running pull would have hit `409 active_job_criteria_conflict`
the moment PR A deployed. It was caught only because the change was tested
against a realistic legacy fixture rather than a freshly generated one.

**Resolution.** `LEGACY_COMPARABLE_CRITERIA_FIELDS` — a job with no criteria
snapshot is compared only on what it can actually prove: `polygon_hash`,
`count_mode`, `entered_count`, `effective_count`, `min_price`, `max_price`,
`sold_months`, `ownership_range_mode`, `ownership_range_days`. Those are also the
fields that determine which properties the pull returns. Identity is excluded
because ownership is verified separately and earlier.

A job with no stored `polygon_hash` has it **recomputed from its polygon** rather
than treated as unknown — otherwise every such job would conflict.

## Classification

| Category | Classification | Evidence |
|---|---|---|
| Created before PR #66 and before PR A (all current production jobs) | `legacy_reconstructed` — resumable and routeable | `ADJ-M2-005`, `PR66-H-03` |
| Created by PR #66 before PR A | `schema_v1_verified` | `AR-EJ-02` |
| Created by PR A, with a price floor | `schema_v1_verified` | `PR66-H-06` |
| Created by PR A, blank minimum | `legacy_reconstructed`, snapshot withheld with a recorded reason | `PR66-H-06` |
| Active job crossing the deployment boundary | `read_only_compatible` — same evidence, same semantics | `ADJ-M2-005` |
| Failed job retried after PR A | `retry_compatible` — repull fields now persisted on both paths | `PR66-H-08` |
| Historical Ghost Mode job (no `polygon_hash`, empty metadata) | `unverifiable` — unchanged by PR A | `AR-EJ-04` |
| Job with no immutable subject | `legacy_reconstructed` for allowance; `unverifiable` downstream | `ADJ-M2-001` |
| Job with a fractional count | `externally_blocked_pending_production_count` | below |

**PR A executes no migration and writes no production record.**

## Blocked production measurement

Required before deciding whether any data fix is needed.
**`EXTERNALLY_BLOCKED`** — this work order does not authorize production access.
The query below was **not executed**, and row counts must not be inferred from
fixtures or source.

```sql
-- Read-only. Intended for a production replica.
SELECT
  count(*) FILTER (WHERE precision_usage_user_id IS NULL)  AS missing_immutable_subject,
  count(*) FILTER (WHERE polygon_hash IS NULL)             AS missing_polygon_hash,
  count(*) FILTER (WHERE precision_usage_reserved
                         <> floor(precision_usage_reserved)) AS fractional_reserved,
  count(*) FILTER (WHERE status IN ('running', 'pending')) AS active_at_deploy,
  count(*)                                                 AS total
FROM fetch_jobs
WHERE mode_tag = 'PRECISION_TARGET'
   OR (mode_tag IS NULL AND provider = 'batchdata');
```

| Count | Decision it affects |
|---|---|
| `missing_immutable_subject` | whether `CH-01`'s email fallback needs a backfill, and how large the population is that PR #66 cannot route at all |
| `missing_polygon_hash` | whether the recompute path is exercised in practice or is dead defensive code |
| `fractional_reserved` | whether existing fractional jobs need a data fix — `CH-03` prevents new ones but repairs no old ones |
| `active_at_deploy` | the blast radius if the legacy-comparison rule is wrong |

**Changes that cannot safely ship without this measurement: none in this PR.**
Every change fails safe for records in the categories above — they keep their
current classification or improve on it. A **backfill** would require these
counts, and PR A performs none.

## Migration deliberately not performed

Model 1 considered backfilling `metadata.workspace_id` from
`precision_usage_user_id`. **Model 2 rejects this.**

The correct value is `team_manager_id || id` *for the owner at the time the job
ran*. Backfilling the subject writes the **wrong** workspace for every rep under
a manager, silently changing an authorization scope — worse than leaving the
record as it is. PR #66's derivation already covers the read path correctly and
uses the *current* authenticated actor, which is strictly safer than a stale
backfilled value.
