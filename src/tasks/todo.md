# Current Task: Recover stalled 16-cell ingestion job and reduce write pressure

## Plan
- [x] Confirm whether the latest job stopped, failed, or is still running.
- [x] Identify why it stopped and why runtime increased.
- [x] Make Base44 429 processor errors resumable instead of terminal failures.
- [x] Reduce ingestion storage writes by defaulting property writes to Neon only.
- [x] Allow the processor to resume the failed rate-limit job from saved progress.
- [x] Verify the processor accepts the resumed job.

## Review
The latest 16-cell job failed at 10/16 completed cells after a Base44 429 during the end-of-chunk progress write. Runtime increased because the corrected grid now fetches 16 cells instead of the prior under-covered 11, and the old default still wrote property records to Base44 as well as Neon. Updated the processor so Base44 429s are resumable and new processing defaults to Neon-only storage. Verification resumed job `69f41abc7f4381fa9d25f154` successfully from sub-circle 11/16 and advanced it after fetching 235 raw / 228 mapped records.