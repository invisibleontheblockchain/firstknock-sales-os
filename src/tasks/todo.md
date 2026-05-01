# Current Task: Fix merged route optimization and Knock tab route command hookup

## Plan
- [x] Inspect runtime logs for the Optimize click failure and route-command UI errors.
- [x] Trace the merged-route data shape from RouteCommandPanel into the optimizer/Knock route flow.
- [x] Patch only the broken hookup/data-shape issue, preserving existing route behavior.
- [x] Verify no new runtime/build errors after the merge and Knock handoff patch.

## Review
Fixed merged routes so they are saved as real active `SavedRoute` records before originals are deleted. The selected route is now handed off to the Knock tab through local storage, and Optimize can re-use hydrated route properties instead of failing when the route is not in the current map cache.