# Current Task: Fix optimize button after route merge

## Plan
- [x] Confirm the runtime behavior after merging routes.
- [x] Trace whether merged routes are saved active routes or temporary generated routes.
- [x] Patch merge so the merged route is saved back as an active route.
- [x] Keep full-property merge behavior from the previous fix.
- [x] Verify the merged route can still be selected and re-optimized.

## Review
The merge flow was creating a temporary generated route via `onReplaceRoutes`, not a saved active route. The optimize/re-optimize action belongs to saved active routes, so after merging there was no proper saved route target for that button. Updated merge to create a new `SavedRoute` first, then delete the original routes, preserve assignment/manager/start-location metadata, and select the saved merged route. Runtime check shows no new merge/optimize exception after the patch.