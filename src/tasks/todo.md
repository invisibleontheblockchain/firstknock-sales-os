# Current Task: Fix saved route map popup/rendering

## Plan
- [x] Check runtime logs for route click and map render errors.
- [x] Inspect Route Command selection and map active-route rendering path.
- [x] Identify why hydrated routes still do not visibly pop up on the map.
- [x] Apply the smallest fix so clicking a saved route opens it properly on the map.
- [x] Verify with backend/function logs and behavior checks.

## Review
ActiveRoutesTab was bypassing the saved-route hydration wrapper, and active routes were not automatically fitting the map viewport. Patched both so selected saved routes load their coordinates and the map zooms to them. Verified the route property lookup returns mapped coordinates successfully.