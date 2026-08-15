# Precision start characterization

This records the behavioral comparison made from PR #66's original head
`85556d19bf16656fb2ef3357e4ef87934fe2f591` before the two Precision start
paths were reduced to adapters around the shared control plane.

The executable matrix is
`test/precision-start-characterization.test.mjs`. It invokes both endpoint
adapters with equivalent, fully local fixtures. It makes no paid provider call.

## Original endpoint differences

| Difference at the original PR head | Classification | Resolution |
| --- | --- | --- |
| `startBatchDataPull` used Base44 SDK 0.8.25 while `fetchAreaProperties` used 0.8.31. | Reliability defect | Both start adapters use 0.8.31. Other functions keep their existing pins unless separately characterized. |
| Only `startBatchDataPull` recognized the immutable-ID `BETA_ACCESS_GRANTS` document and a hardcoded email grant. | Authorization defect | Entitlement normalization is shared, and the email-based bypass was removed. Beta/granted access now requires a versioned `BETA_ACCESS_GRANTS` entry keyed by immutable user ID. |
| `startBatchDataPull` understood beta periods and limits in its usage ledger; `fetchAreaProperties` treated the same jobs as trial/free. | Reliability defect | One shared entitlement and ledger contract now handles free, trial, paid and beta/granted access. |
| `startBatchDataPull` released explicit reservations after ten minutes; `fetchAreaProperties` did not. | Reliability defect | Time never releases an explicit reservation. Every new start is blocked until server-owned exact settlement clears it. |
| `fetchAreaProperties` accepted the old `record_cap` alias; `startBatchDataPull` did not. No in-repository caller uses the alias. | Legacy compatibility behavior | The alias is not authorization evidence and was removed from live start parsing. Fixed Count uses `requested_properties`; Max Available uses its mode and ignores browser allowance estimates. Any out-of-repository caller still using `record_cap` must migrate. |
| Only `startBatchDataPull` accepted `self_test_force_free`, and only for a dry run. | Intentional adapter behavior | Preserved only on `startBatchDataPull`; it remains non-mutating. |
| Dry-run and start envelopes differed (`success`, `status`, `phase`, and message wording). | Intentional adapter behavior for the stable envelope; duplicated decision wording was a reliability defect | The adapters retain the expected `success`/dry-run envelope where needed. Core status, counts, criteria, errors and decisions come from the shared engine. |
| Start timestamp metadata used `paid_pull_started_at` versus `batchdata_only_started_at`. | Legacy compatibility behavior | Both jobs now receive canonical `precision_started_at`; the adapter-specific timestamp is also retained for existing readers. |
| Only `fetchAreaProperties` initialized `error_log` and `chunk_timings`. | Reliability defect | Shared FetchJob creation initializes both fields for every start. |
| `fetchAreaProperties` declared 40/300-square-mile limits and a bounds helper, but did not enforce either; `startBatchDataPull` had no such live cap. | Reliability/maintenance defect, resolved contract | Dead constants were removed. The authoritative policy is no artificial area/span cap, while malformed or degenerate polygons fail. Repository evidence is commit `d9520fdc07851dee14c63ea551b74c64ff241ca0` (`chore: remove square mileage and span limits...`), `src/tasks/lessons.md:183`, and `src/tasks/todo.md:335+`. |
| Each endpoint independently performed pre-lock entitlement and allowance reads and then repeated them inside the lock. | Reliability defect | Start authorization, current allowance and effective count are calculated once inside the immutable-user advisory lock. Dry runs are explicitly non-authoritative and non-mutating. |
| Provider-handoff logging named the adapter differently. | Intentional adapter behavior | Adapter-specific log labels remain. A failed handoff leaves the already-created pending job and reservation for watchdog recovery. |
| Neither endpoint had a server-authoritative failed-job retry contract. | Unresolved contract in the original head | Both adapters now accept only `retry_fetch_job_id` and derive the replacement request from verified persisted criteria. Browser criteria, email, identity hints and allowance estimates cannot authorize a retry. |

## Pinned shared behavior

The matrix covers:

- free, trial, paid and dynamic granted access;
- non-mutating dry runs and the explicit no-area-cap policy;
- Fixed Count capping and locked Max Available calculation;
- quick and custom ownership ranges;
- malformed polygons, counts, price ranges, ownership ranges and route bounds;
- exact single-active resume and visible multiple-active conflict;
- settled failed predecessors and unsettled reservations of different ages;
- persistence failure before processor invocation; and
- processor-handoff failure after durable job creation.

Additional retry, identity, strict-schema, polygon, settlement and provenance
cases live in `test/precision-control-plane.test.mjs` and
`test/precision-active-resolver.test.mjs`.
