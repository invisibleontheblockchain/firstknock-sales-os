# PR A — Precision Order and Control Hardening

Stages 0–4. C0 exact user intent → C1 server-authoritative target → one
canonical FetchJob that PR #66 consumes without guessing.

**Status:** draft. `PR_A_TO_PR66_HANDOFF: PASS`.

## Coordinates

| | |
|---|---|
| Model 2 branch | `hardening/precision-order-control-model-2` |
| Model 2 base | `03adf5cd59aba8c4b7f095d4a799085ecb9f7186` (= `origin/main`, unchanged) |
| Model 1 audit branch | `audit/precision-order-control-model-1` |
| Model 1 candidate SHA | `0c3fd666bfa0ba5b506503578d727d201c62fbdc` — verified |
| PR #66 audited head | `35396b50457e93fc3c5a1d838a23fae787c75fa6` |
| PR #66 current head | `35396b50457e93fc3c5a1d838a23fae787c75fa6` — unchanged, Stage 5 expectations unaffected |

## Documents

| Document | Use |
|---|---|
| [MODEL_2_INDEPENDENT_AUDIT.md](MODEL_2_INDEPENDENT_AUDIT.md) | what Model 2 reconstructed and mutation-tested before reading Model 1's conclusions |
| [MODEL_1_FINDING_ADJUDICATION.md](MODEL_1_FINDING_ADJUDICATION.md) | **every material finding, adjudicated** — accepted, revised, deferred |
| [FINAL_TARGET_CONTRACT.md](FINAL_TARGET_CONTRACT.md) | the Stage 0–4 contract PR A implements |
| [ORDER_TO_FETCHJOB_CONTRACT.md](ORDER_TO_FETCHJOB_CONTRACT.md) | canonical FetchJob, field by field |
| [CHANGE_LEDGER.md](CHANGE_LEDGER.md) | every production change and why its scope is sufficient |
| [VALIDATION_LEDGER.md](VALIDATION_LEDGER.md) | commands, results, mutation record |
| [PR66_HANDOFF_REPORT.md](PR66_HANDOFF_REPORT.md) | handoff proof against PR #66's real caller chain |
| [EXISTING_JOB_COMPATIBILITY.md](EXISTING_JOB_COMPATIBILITY.md) | every existing-job category, and the blocked production measurement |
| [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md) | measured before/after |
| [PR_A_FINAL_REPORT.md](PR_A_FINAL_REPORT.md) | final report |
| [stages/](stages/) | per-stage adjudication detail |

## The five changes

1. **Cross-subject allowance attribution closed** — a job owned by another
   immutable subject can no longer be charged to you, or block your pulls.
2. **Polygon vertices range-validated** — `lat: 200` and swapped rings rejected;
   a malformed vertex is reported instead of silently changing the geometry.
3. **Invalid counts rejected** — `0`, negatives, decimals and non-numeric values
   no longer silently mean "max available" or produce fractional reservations.
4. **Max Available is server-authoritative** — resolved inside the usage lock
   instead of being capped by a stale browser snapshot.
5. **Active-job decision is criteria-aware** — four explicit outcomes; only an
   exact match resumes; a client flag can no longer destroy server-owned work.

Plus: workspace, schema version, provider contract version and a criteria
snapshot are persisted, and Preview contains provider failures.

## Not resolved

- **Fixed Count semantics** (`ADJ-M2-009`) — a product decision; PR A assumes neither reading.
- **`min_price` default divergence** — owned by PR #66.
- **Hard-coded email entitlement grant** — needs that account's immutable id first.
- **Sandbox-key billing** — `EXTERNALLY_BLOCKED`.
