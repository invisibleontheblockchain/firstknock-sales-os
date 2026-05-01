# Current Task: Explain why merging 3 routes shows only 431 doors

## Plan
- [x] Inspect the merge UI code for generated and saved routes.
- [x] Check runtime logs around the route generation and merge action.
- [x] Inspect saved route hydration behavior.
- [x] Verify whether merge uses filtered hydrated route properties instead of original saved route hashes.
- [x] Fix merge logic if it is losing saved-route doors.
- [x] Verify with the current route data.

## Review
The active-route merge was using `route.properties`, which is the currently hydrated/display-filtered route list. That means sold-date filters, missing hydration, or visible-route filtering could shrink the merged route before merge. Updated saved-route hydration to preserve `allProperties` and changed merge to use that full list while still deduping duplicate addresses. Verified the current saved routes are present and the merge code now reads the full saved-route property list instead of the filtered display list.