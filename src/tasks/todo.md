# Current Task: Fix Christian territory polygon coverage

## Plan
- [x] Add a focused admin-only polygon audit/fix function that does not touch eligibility filters, dedup logic, or route generation.
- [x] Retrieve Christian's confirmed FetchJob polygon, sub-circles, and inferred creation metadata.
- [x] Calculate current polygon area in square miles and compare it with the intended ~300 sq mi territory.
- [x] Generate a candidate polygon from the outer boundary of the 16 RentCast sub-circles, constrained by a safety check instead of changing filters.
- [x] Compare current polygon vs candidate sub-circle hull: area, bounds, sub-circle coverage, and per-sub-circle records clipped by the current polygon.
- [x] Verify in dry-run mode whether the candidate polygon would reduce outside-polygon drops near zero.
- [x] Apply only the corrected FetchJob polygon after dry-run verification; do not delete/regenerate Christian's route and do not alter filter/dedup logic. Application was blocked because the candidate area is unsafe.
- [x] Re-run the ingestion diagnostic against the corrected polygon and document outside-polygon drop count plus RentCast per-sub-circle counts. Diagnostic dry-run completed; no production polygon was changed.
- [x] Document final stored active count and note whether a separate re-ingestion is required to materialize newly included records.

## Review
Dry-run disproved the proposed polygon-expansion fix.

Findings:
- Current Christian polygon area: 298.08 sq mi, which is 99.4% of the intended ~300 sq mi territory.
- Current polygon bounds: lat 34.361098 to 34.644346, lng -82.808424 to -82.464718.
- Candidate polygon made from the outer hull of all 16 RentCast 5-mile sub-circles: 1,223.78 sq mi, which is 407.9% of the intended territory.
- The candidate hull would reduce outside-polygon drops from 739 to 0, but only by incorrectly expanding Christian's territory to roughly 4x the paid/intended area.
- Therefore, the polygon is not actually too small relative to 300 sq mi; the 16 sub-circles are intentionally/accidentally much larger than the 300 sq mi polygon because each grid cell has a 5-mile radius and overlaps well outside the drawn boundary.
- The geographic areas excluded by the current polygon are mostly NE (379), NW (156), E (79), N (61), W (51), S (12), and SW (1) relative to the territory center.
- RentCast fetch cap scan: 16 sub-circles were queried independently, page limit is 500, total API calls were 16, and no sub-circle hit the safety cap. The raw total remained 1,362.
- Final stored active candidate count remains 664 because no unsafe polygon expansion or route regeneration was applied.

Decision:
No production polygon update was applied. Expanding the polygon to include all 739 clipped records would violate the 300 sq mi target. The safer next fix is to improve sub-circle generation/fetch efficiency so it does not overfetch huge areas outside the polygon, or explicitly define a larger paid territory if Christian truly intends coverage beyond 300 sq mi.