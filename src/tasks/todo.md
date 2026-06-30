## Plan — Fix Appointments Loading / Empty State
- [x] Inspect the appointment data queries, callback-log merge, loading gates, and current filters.
- [x] Identify why existing appointments are hidden or the page stays effectively empty.
- [x] Patch the smallest root cause without changing appointment business logic.
- [x] Verify with build/static checks and, if needed, data-shape checks against existing records.
- [x] Document the result and lesson from this correction.

### Review — Fix Appointments Loading / Empty State
The Appointments page was masking the first real appointment fetch as an empty result because the query used `initialData: []`, and the render gate waited on slower callback-history reconciliation before showing saved appointment rows. I removed the false initial empty data, made the appointment query wait for the signed-in user and use a user-scoped cache key, and changed the loading gate so saved appointments render while callback history continues loading. `npm run build` passes, static checks confirmed the guards, and service-side data confirms existing appointments belong to the current manager account.

---

## Plan — Fix Appointment View Map White Screen
- [x] Re-check the appointment-to-map URL path that just caused the white screen.
- [x] Patch invalid/missing coordinate handling so missing lat/lng never becomes a fake 0,0 map target.
- [x] Make the map focus handler stop waiting forever when a saved route cannot be loaded on the manager map.
- [x] Verify the app builds and static checks prove the white-screen path now has safe guards.
- [x] Add a lesson so future deep links validate URL params before opening map/detail state.

### Review — Fix Appointment View Map White Screen
The white-screen path was caused by fragile appointment map deep-link handling: missing lat/lng could be parsed as numeric 0/0 and pushed into map/detail focus state. The appointment link now only serializes finite coordinates, Home only accepts coordinates when both params exist and are not null-island values, and route handoff no longer waits forever for a route that is not available in the manager map scope. `npm run build` passes and static checks confirmed the guarded path.

---

## Plan — Appointment Map / Run Handoff
- [x] Add Appointment list/detail actions for “View Map” and “Run”.
- [x] Deep-link View Map into the FirstKnock manager map, centered on the appointment address/property when possible.
- [x] Deep-link Run into Knock mode for appointments tied to a saved route, focused on that appointment’s property.
- [x] Keep manual appointments without route/property data safe: show the map flow when possible and leave Run disabled when there is no route to run.
- [x] Verify with production build and static behavior checks.

### Review — Appointment Map / Run Handoff
Appointments now show touch-safe View Map and Run actions on each card and in the detail modal. View Map opens the FirstKnock manager map, loads the related route when present, centers on the appointment property/coordinates, and opens the property sheet. Run opens Knock mode on the appointment’s saved route and focuses that address; Run stays disabled when an appointment has no route. `npm run build` passes and static checks confirmed every deep-link path is wired.

---

## Plan — Gate 1,000 Homes Behind Paid $99 Plan
- [x] Find every place that grants the 1,000-home capacity or treats trial/card-on-file as equivalent to paid access.
- [x] Update the UI gate so free trial/card-on-file users cannot select or receive the 1,000-home option.
- [x] Update the backend pull/start validation so direct function calls cannot request 1,000 homes unless the $99/month subscription has actually paid.
- [x] Verify the changed behavior with static checks and a production build.
- [x] Document results and add a lesson to prevent future trial-vs-paid gating mistakes.

### Review — Gate 1,000 Homes Behind Paid $99 Plan
The 1,000-home Precision capacity now requires an active Precision/Pro subscription with `subscription_paid_confirmed === true`, which Stripe sets only after a paid invoice/paid checkout. Free trials and card-on-file accounts are capped at 50 homes in the UI and blocked in `startBatchDataPull`; direct forced-free self-test rejected 1,000 with 403 and allowed 50 with 200. `npm run build` passes.