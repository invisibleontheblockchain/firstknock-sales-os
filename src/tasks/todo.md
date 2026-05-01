# Current Task: Fix 300 sq mi grid sub-circle coverage

## Plan
- [x] Replace the square-ish dynamic spacing in `fetchAreaProperties.generateSubCircles` with true 5-mile hex packing.
- [x] Use horizontal spacing `2r*cos(30°)` and vertical spacing `1.5r`.
- [x] Ensure a ~300 sq mi / ~9.77mi radius area generates a 4×4 16-circle grid.
- [x] Keep single-circle behavior for areas at or below 5 miles.
- [x] Document the before/after coverage and expected sub-circle count.
- [x] Verify deployment/syntax with a safe backend function test.

## Review
Updated `fetchAreaProperties.generateSubCircles` to use true hex spacing and retain the full planned grid, so a ~300 sq mi territory now creates 16 sub-circles. Added `docs/hex-grid-300sqmi-coverage-diff.md` documenting the before/after coverage behavior.