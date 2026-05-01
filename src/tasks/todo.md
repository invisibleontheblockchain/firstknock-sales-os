# Current Task: Fix saved route click-to-map hydration

## Plan
- [x] Check runtime logs for click/open errors.
- [x] Inspect saved route selection and map rendering path.
- [x] Add a focused route-property hydration backend path for saved routes with empty map properties.
- [x] Wire hydration into Route Command card selection instead of editing oversized Home directly.
- [x] Verify Kevin’s routes can load full map points after selection.

## Review
Initial Home edit was blocked because the file is over the platform edit limit. Re-planned the fix into Route Command, where saved-route card clicks already originate. Added a MasterProperty fallback because Kevin route hashes may not exist in the current Neon workspace query. The click handler now hydrates route properties before opening the route on the map.