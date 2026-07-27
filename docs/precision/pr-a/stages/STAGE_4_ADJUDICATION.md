# Stage 4 Adjudication — lock, active jobs, reservation, canonical FetchJob

**Adjudications** `ADJ-M2-005`, `ADJ-M2-006`, `ADJ-M2-007`.
**Model 1 findings** `F-PRA-036`–`F-PRA-049`, `F-PRA-062`–`F-PRA-064`.

| Aspect | Current | Model 1 | Model 2 | Final target | Change |
|---|---|---|---|---|---|
| Active-job comparison | **none** in quick mode | PROVEN_DEFECT (P0) | confirmed | exact match only | **CH-05** |
| Lookup key | `user_email`, unsorted, index 0 of 5 | PROVEN_DEFECT | confirmed | both keys, ownership-verified, deterministic | **CH-05** |
| Outcomes | 2 implicit | PROVEN_DEFECT | confirmed | 4 explicit | **CH-05** |
| Client-flag cancellation | destroys healthy jobs | PROVEN_DEFECT | confirmed | removed | **CH-05** |
| Age-based cancellation | destroys any job > 120s | PROVEN_DEFECT | **revised** | conflicting jobs only | **CH-05, narrowed** |
| Reservation release on cancel | never | PROVEN_DEFECT | confirmed | — | **not changed** |
| Reservation + job write | one write | KEEP | confirmed | unchanged | none |
| Advisory lock | one shared key | KEEP | confirmed against a real serializing lock | unchanged | none |
| Versions / workspace / snapshot | absent | PROVEN_DEFECT | confirmed | persisted | **CH-06** |
| Corrupt metadata | 500 | PROVEN_DEFECT | confirmed | contained | **fixed incidentally** — `ownershipFromJob` is no longer on this path |

## Why age-based cancellation was narrowed, not removed

Model 1 proposed removing both cancellation paths. Model 2 removed only the
client-flag path — an unverified flag destroying server-owned work is
indefensible on any reading. The age-based path is the **only** in-app escape
hatch from a genuinely stuck import; removing it without the remedy UI leaves
users blocked for up to 30 minutes (`watchdogStaleJobs`). Narrowing it to
*conflicting* jobs removes the real data loss — an identical job is now resumed
rather than destroyed — without stranding anyone.

## Reservation release — deliberately not fixed

`F-PRA-040`: a cancelled job keeps consuming allowance until a separate 10-minute
rule. Settlement is the processor's sole responsibility, and introducing a second
writable truth to close a 10-minute accounting window is not justified by the
evidence. `DOCUMENT`.

## The legacy-comparison rule

Comparing a pre-PR-A job against the full material set would `409` **every
in-flight job at deploy time**. `LEGACY_COMPARABLE_CRITERIA_FIELDS` restricts the
comparison to what such a job can actually prove. This was a genuine near-miss
and is the single most important compatibility decision in PR A — see
[EXISTING_JOB_COMPATIBILITY.md](../EXISTING_JOB_COMPATIBILITY.md).

## Preserved

Single-write reservation, shared advisory lock, entitlement and allowance
re-derived inside the lock, processor invoked once after the lock closes, and
dry-run inertness. All verified against a real serializing lock; no concurrency
scenario over-reserved.
