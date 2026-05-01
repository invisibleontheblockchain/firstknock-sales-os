# Current Task: Investigate Christian ingestion/eligibility candidate gap

## Plan
- [x] Use runtime/backend evidence to identify the latest Christian full-territory fetch job and its stored fetch counters.
- [x] Inspect existing diagnostic functions for reusable Neon/RentCast count tooling before adding anything new.
- [x] Produce stage counts: raw fetch total, after eligibility/status filter, after deduplication, final stored active candidates.
- [x] Check all 16 sub-circles for zero-result/error gaps and confirm whether each contributed records.
- [x] Check ingestion filters, dedup logic, and any stored caps/batch limits for the big ~2,000 → 664 drop.
- [x] If existing tooling cannot expose these counts, create a focused backend diagnostic function without changing route generation.
- [x] Run the diagnostic and document findings in this file.

## Review
Diagnostic function `investigateChristianIngestionGap` was added as read-only and does not modify route generation or stored candidate data.

Christian job inspected: `69f4c4874afc1c64585ce193` for `christian@nativapest.com`.

Stage counts:
- Raw fetch total across 16 sub-circles: 1,362
- After ingestion eligibility/status filter: 606
- After global deduplication: 478
- Final stored total in workspace: 729
- Final stored active candidates: 664
- Stored inactive/rejected: 65

Conclusion:
The expected ~2,000 properties are not being fetched by the current ingestion query. RentCast returned only 1,362 raw deed records for the 12-month deed window over the 16 sub-circles. The biggest proven loss inside our pipeline is the eligibility/polygon layer: 1,362 → 606. Dedup then removes 128 more overlapping sub-circle duplicates: 606 → 478. The stored 664 active count is higher than the latest job's unique phase-1 hashes because the workspace also contains earlier/other valid records.

Sub-circle coverage:
All 16 sub-circles completed; no API errors were found. Some cells returned zero raw or zero eligible records, but that is due to area/polygon geometry and RentCast result distribution, not silent job failure.

Likely culprit:
There is no evidence of a stored candidate cap. Drop 1 is mainly caused by (a) RentCast's deed-only 12-month query returning far fewer than the Redfin residential reference, and (b) ingestion eligibility/polygon filters removing more than half of the raw deed records. The Redfin ~2,000 number may include all residential properties or a broader listing window, while the app currently ingests recent sale/deed candidates only.