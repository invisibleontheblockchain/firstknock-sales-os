# Current Task: Route command summary, all-in-one assignment, and analytics accuracy

## Plan
- [x] Inspect runtime logs for analytics and route-progress symptoms.
- [x] Review route command summary/all-in-one save flow and rep analytics route-count logic.
- [x] Ensure all-in-one generated routes are assigned to the current user by default.
- [x] Tie analytics counts to Neon-hydrated route properties instead of stale/incomplete local counts.
- [x] Clean up the route generation summary copy without changing route generation behavior.
- [x] Verify code paths and document results.

## Review
Runtime logs showed RepHome correctly loaded 415/415 properties first, then later fetched only 12/12 after the selected route/hash count changed. I updated route property loading to refetch when the active route hash count changes, and Today's Performance now uses the larger of hydrated properties, route hashes, or saved route house count so progress can show 1/415 instead of 1/12. Analytics now uses Neon-backed candidate loading plus Neon-hydrated saved routes for route progress/status totals, and Merge All now saves the all-in-one route through the existing save flow so it is assigned to the current user by default. The generation summary copy is simplified to show doors ready and route count.