# Performance Report — PR A

**Measured, not asserted.** Both sides were run through the same harness on the
same machine; the "before" side was produced by checking out `origin/main`'s two
start-path files, measuring, and restoring.

- **Method:** `runStartPath` with an identical order (`requested_properties: 25`,
  free account, no active jobs), driving the real handlers.
- **Sample size:** 25 starts per path per side.
- **Counters** come from the harness trace, so they are exact, not sampled.
- **Timings** are in-process against stubbed I/O. They measure *handler work*,
  not real database or Stripe latency, and should not be read as click-to-job
  latency.

## Results

| Metric | `startBatchDataPull` before → after | `fetchAreaProperties` before → after |
|---|---|---|
| Median handler time | 13.80 ms → **15.68 ms** (+1.88) | 11.54 ms → **13.65 ms** (+2.11) |
| p95 handler time | 28.69 ms → 35.30 ms | 12.59 ms → **14.63 ms** |
| **Entity reads** | 8 → **10** (+2) | 8 → **10** (+2) |
| **Entity writes** | 1 → **1** | 1 → **1** |
| Entitlement resolutions | 2 → **2** | 2 → **2** |
| External HTTP calls | 1 → **1** | 1 → **1** |
| Processor invocations | 1 → **1** | 1 → **1** |
| Reservation conflicts | 0 → 0 | 0 → 0 |

## What changed and why

**+2 entity reads per start.** The active-job lookup previously issued two
queries keyed on `user_email` alone. It now issues four — `running` and `pending`
against both `precision_usage_user_id` and `user_email` — so ownership can be
verified by immutable subject instead of trusting an email-keyed page.

That is the cost of closing `ADJ-M2-001` and `ADJ-M2-005`. Two extra indexed
reads inside a per-user advisory lock is a proportionate price for preventing a
second account from consuming a user's allowance and blocking their pulls.

**~2 ms median.** Attributable to the extra queries plus criteria construction
and comparison. Both are in-memory and O(18 fields).

## What did **not** get worse

- **Writes are unchanged at exactly 1.** The reservation and the FetchJob remain
  a single fused write; PR A did not introduce a second writable truth.
- **Entitlement resolutions are unchanged at 2.** PR A did not fix the duplicate
  pre-lock/in-lock resolution (Model 1 `F-PRA-005`) — that is a refactor without
  an adjudicated defect behind it, so it was out of scope.
- **External HTTP is unchanged at 1** (the county lookup). No new provider or
  third-party call was added anywhere.
- **Processor invocations remain exactly 1.**
- **Time inside the lock** grew by the same ~2 ms; the lock is per-subject, so
  this does not increase cross-user contention.

## Not measured

| Metric | Why |
|---|---|
| Usage-lock wait time under real contention | needs a real Postgres advisory lock and concurrent production traffic — `EXTERNALLY_BLOCKED` |
| Click-to-FetchJob duration | needs a browser and real network — no DOM tooling in this repository |
| Real Stripe / Base44 / `geo.fcc.gov` latency | all stubbed; measuring them would require production access |
| Preview invocation count in production | needs telemetry that does not exist yet (Model 1 `PC-PRA-017`) |

**No performance improvement is claimed.** PR A costs approximately 2 ms and two
indexed reads per start, and buys correctness in exchange. Nothing was optimised
at the expense of correctness, and no correctness change was skipped to protect
a number.
