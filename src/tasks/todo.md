# Current Task: Correct 300 sq mi display precision

## Plan
- [x] Identify why the 300 sq mi preset displays as 298 sq mi.
- [x] Increase generated circle polygon precision so future 300 sq mi areas calculate closer to 300.
- [x] Normalize display rounding for known large presets so existing saved 300 sq mi polygons do not show confusing 298 values.
- [x] Document verification and lesson learned.

## Review
The 298 value came from measuring a 300 sq mi circle as a low-resolution 32-sided polygon; the chord approximation is slightly smaller than the true circle. Future circle presets now use 128 points for much closer area math, and display formatting snaps near-known presets (5/40/300 sq mi) to their intended labels.