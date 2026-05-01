# PipelineLock + Batched FetchJob Updates — Before/After

## Problem
Large Fill Gaps runs can self-chain `processFetchChunk` while a manual test or cron invocation starts another processor for the same `FetchJob`. Both processors then read/write the same `FetchJob` rapidly, causing Base44 control-plane 429s.

## Before
- No durable per-job processor lock.
- Duplicate invocations were only protected by `expected_chunk`, which does not stop two processors from starting the same current chunk.
- Base44 `FetchJob` writes could stack when overlapping processors ran.
- An 11-sub-circle run could create roughly 5–8 writes per sub-circle under duplicate execution pressure.

## After
- New `PipelineLock` entity protects one `FetchJob` at a time.
- `processFetchChunk` claims a 90-second lock before processing.
- If another active lock exists, the duplicate invocation exits immediately without processing or writing progress.
- Expired locks are deleted so crashed processors do not permanently block the job.
- The lock is released before self-invoking the next chunk, allowing the next chunk to claim its own lock.
- Normal progress writes remain one end-of-chunk `FetchJob` update; terminal `completed`/`failed` writes remain immediate.

## Expected write reduction
For the Anderson 11-sub-circle run:
- Before overlap protection: duplicate processors could multiply chunk writes and trigger Base44 429s.
- After lock: only one processor writes progress for the job at a time.
- Effective steady-state target: about 1 normal progress write per chunk, plus immediate running/completed/failed state changes.

## Files changed
- `entities/PipelineLock.json`
- `functions/processFetchChunk`

## Verification plan
1. Trigger one processor run while a job is active.
2. Trigger a second processor run immediately.
3. Confirm the second invocation returns `skipped: true` with `active_lock` or `lost_lock_race`.
4. Confirm the original job continues advancing normally.