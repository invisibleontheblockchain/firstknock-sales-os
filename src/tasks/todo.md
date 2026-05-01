# Current Task: Fix saved route hydration 500 error

## Plan
- [x] Check runtime logs for the backend 500 error.
- [x] Inspect the route hydration function path causing the failed request.
- [x] Patch rate limiting by deduplicating frontend hydration requests and bulk-loading backend fallbacks.
- [x] Add support for actual saved route hash format (`ADDRESS|ZIP`).
- [x] Verify the function succeeds with actual saved route hashes and no new runtime errors appear.

## Review
Runtime logs show the 500 came from Base44 SDK rate limiting inside getRoutePropertiesByHashes after repeated route clicks triggered many per-property fallback lookups. Replaced per-hash fallback calls with bulk lookups and added frontend cache/in-flight protection so repeated clicks reuse one request. Verified actual saved-route hashes like `502 HOLLY CREEK DR|29621` return mapped coordinates successfully.