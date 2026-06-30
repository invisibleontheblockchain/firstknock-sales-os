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