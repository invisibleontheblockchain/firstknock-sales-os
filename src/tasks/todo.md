# Current Task: Fix Anderson route count, route line color, and sold-route save

## Plan
- [x] Check runtime logs for save failures and route-loading errors.
- [x] Trace why the Knock tab shows 281 homes for the Anderson County route when the source route has 415.
- [x] Fix route hydration/display so saved route shells keep the full property count even if some property details are missing.
- [x] Change default mail-carrier route lines from red to gold.
- [x] Fix the Home sold-route save button failure.
- [x] Verify via code path/log review and document the result.

## Review
Runtime logs showed Anderson County generated 415 doors, but Knock loaded route homes from old Base44 MasterProperty batches, where only 281 records were available. RepHome now uses the Neon-backed route lookup used elsewhere and preserves the saved route hash order without address deduping away stops. Route lines now default to gold, and filtered-route SAVE now creates the visible filtered route directly from the toolbar so price/date/phase filtered views save correctly.