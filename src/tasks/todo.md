# Current Task: Explain and diagnose Redfin vs FirstKnock coverage gap

## Plan
- [x] Confirm the latest Anderson-area fetch job totals and completion state.
- [x] Compare expected Redfin-style sold inventory vs FirstKnock's current ingestion windows.
- [x] Identify whether the gap is caused by coverage, filters, source mismatch, or BatchData verification failure.
- [x] Apply the smallest safe correction to grid edge coverage.

## Review
The latest 300mi² Anderson pull completed all 7 generated sub-circles, but the grid generator was excluding edge circles unless their centers were within radius + 1.5mi. Because each sub-circle fetches a 5mi radius, valid edge coverage requires including all circles whose centers are within radius + 5mi. Updated the cutoff so future Fill Gaps pulls cover the full requested boundary more completely.