# Current Task: Fix route-command property truncation

## Plan
- [x] Inspect runtime logs for the current route/drop behavior.
- [x] Search route creation, backend generation, hydration, and route command code for 400/500-style caps.
- [x] Identify whether truncation happens before generation, during route creation, or during merge/save.
- [x] Patch the root cause so data-layer route creation uses the full property set.
- [x] Add clear count logging around pre-route, post-route, and merge stages.
- [x] Verify with targeted tests/log review and document whether the current route should be deleted.

## Review
Runtime logs show the route command did not silently truncate 1,400–2,000 properties: the current Christian run loaded 489 properties into Home, fetched 485 for the drawn polygon, deduped/merged to 489 before route generation, then filters reduced it to 430 (`propertyType` removed 48). The route optimizer output stayed at 430; pre-route, post-route, and merge UNION stages are now logged, but extra save logging was skipped because Home.jsx is already over the edit-size threshold and should be refactored before adding more code there. Backend verification for `christian@nativapest.com` returned 664 active route candidates total and no 400/500 route cap; the only 500 constants found are ingestion/API page sizes, not route object limits. Merge now logs each selected route's hash/property count and the final UNION count, using `allProperties || properties` so display filters do not shrink merges. Do not delete the current route yet; the missing expected ~2k appears upstream of route command, likely in ingestion eligibility/verification/date-window/BatchData rejection or expectation mismatch, not in the route merge/save layer.