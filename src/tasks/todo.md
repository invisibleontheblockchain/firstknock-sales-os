# Current Task: Explain 1200+ pulled properties vs 428 route properties

## Plan
- [x] Check the latest fetch job totals and completion status.
- [x] Check the latest generated route size and saved route metadata.
- [x] Compare raw fetched, mapped, inserted/existing/updated, and route candidate counts.
- [x] Identify whether records are being dropped by ingestion, deduplication, eligibility filters, or route limits.
- [ ] Fix any confirmed loss point and verify with a backend check.

## Review
The latest job completed all 16 grid cells. The high pull number was not the final route-eligible unique house count: it included raw RentCast records from overlapping circles plus duplicates and records later filtered out. Route generation fetched 484 properties for the drawn area, geography kept 477, and the property-type route filter reduced that to 428. The main confirmed gap is filtering/deduping, not the job stopping; next step is to inspect whether the property-type filter is too strict.