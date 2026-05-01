# Current Task: Fix Kevin route visibility in Route Command

## Plan
- [x] Check runtime logs for Route Command load/filter behavior.
- [x] Inspect route loading and Route Command filtering logic.
- [x] Verify Kevin’s account/team ownership fields against the UI filters.
- [x] Correct route ownership/status fields if data is hidden by filtering.
- [x] Verify routes appear-eligible for Route Command after the fix.

## Review
Found the Route Command bug: saved routes were filtered out when their properties could not hydrate from the currently loaded map dataset. The route records were ACTIVE, but `hydratedSavedRoutes` dropped routes with `properties.length === 0`, so Route Command showed none when Neon returned 0 properties. Patched saved-route hydration to keep saved routes visible using saved metrics/property hashes even when property details are not loaded yet.