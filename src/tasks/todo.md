# Plan

- [x] Inspect the selected Data Status indicator calculation.
- [x] Confirm what the displayed number is meant to represent from surrounding usage.
- [x] Fix the indicator with the smallest UI/data-label change.
- [x] Verify there are no new runtime errors.

## Review
The indicator was showing `user.territory_property_count`, which is a saved metadata value from prior pulls and can become stale compared with the current map/filters. To avoid displaying an inaccurate number, the status badge now shows a clear `DATA READY` state when data exists and `NO DATA` otherwise.