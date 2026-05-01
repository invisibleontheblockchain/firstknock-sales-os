# 300 sq mi Hex Grid Coverage Fix

## Before
`fetchAreaProperties.generateSubCircles` used equal X/Y spacing:

- `step = 5 * 2 * 0.80 = 8mi`
- same 8mi spacing vertically and horizontally
- odd rows shifted by half a longitude step only
- dynamic `stepsNeeded` grid filtered by center distance

This looked hex-like, but it was not true hex packing. For a ~300 sq mi territory (~9.77mi radius), it could produce too few useful edge cells and leave boundary wedges under-fetched.

## After
The grid now uses true 5-mile hex packing:

- horizontal spacing: `2r * cos(30°) = 8.66mi`
- vertical spacing: `1.5r = 7.5mi`
- odd rows offset by half the horizontal spacing
- grid dimensions derived from the full diameter, producing the expected 4×4 coverage for ~300 sq mi pulls
- all planned grid cells are retained so edge/corner wedges are fetched instead of filtered out prematurely

## What did not change
- `FetchJob` schema
- processor self-chain
- RentCast fetch logic
- BatchData verification
- Neon writes
- cron watchdog behavior

## Expected result
A ~300 sq mi / ~9.77mi radius territory now generates 16 sub-circles instead of the under-dense live grid, so edge portions of the territory are fetched instead of silently skipped.