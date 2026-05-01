# Current Task: Reduce RentCast sub-circle overfetch without losing polygon coverage

## Plan
- [ ] Keep the existing 5-mile RentCast sub-circle strategy and polygon clipping unchanged for correctness.
- [ ] Add polygon-aware pruning inside `fetchAreaProperties.generateSubCircles` so only sub-circles whose 5-mile fetch radius overlaps the drawn polygon are kept.
- [ ] Avoid unsafe center-distance shortcuts that can drop valid boundary coverage; use point-in-polygon plus point-to-polygon-edge distance instead.
- [ ] Add dry-run diagnostics to report original sub-circle count, pruned count, estimated fetch area, and estimated API savings without creating a FetchJob.
- [ ] Verify against Christian’s territory using dry-run only: confirm fewer sub-circles and no production jobs, route regeneration, or data changes.
- [ ] Document final before/after diagnostics and any lessons learned.

## Review
Pending confirmation before implementation.