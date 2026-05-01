# Current Task: Reduce RentCast sub-circle overfetch without losing polygon coverage

## Plan
- [x] Keep the existing 5-mile RentCast sub-circle strategy and polygon clipping unchanged for correctness.
- [x] Add polygon-aware pruning inside `fetchAreaProperties.generateSubCircles` so only sub-circles whose 5-mile fetch radius overlaps the drawn polygon are kept.
- [x] Avoid unsafe center-distance shortcuts that can drop valid boundary coverage; use point-in-polygon plus point-to-polygon-edge distance instead.
- [x] Add dry-run diagnostics to report original sub-circle count, pruned count, estimated fetch area, and estimated API savings without creating a FetchJob.
- [x] Verify against Christian’s territory using dry-run only: confirm fewer sub-circles and no production jobs, route regeneration, or data changes.
- [x] Document final before/after diagnostics and any lessons learned.

## Review
Implemented universal polygon-aware sub-circle pruning in `fetchAreaProperties`.

What changed:
- All users now use the same pruning logic whenever a polygon is supplied.
- The existing 5-mile RentCast circle radius and hex spacing remain unchanged.
- Generated grid cells are pruned only when their fetch circle does not overlap the drawn polygon.
- Added read-only `dry_run: true` diagnostics that create no FetchJob, start no processor, and make no RentCast calls.

Verified dry-run for Christian's territory:
- Original grid cells: 16
- Pruned grid cells: 12
- Removed cells: 4
- Estimated fetch area before: 1,256.6 sq mi
- Estimated fetch area after: 942.5 sq mi
- Estimated API savings: 25%
- Dry-run returned 200 and confirmed no FetchJob creation.