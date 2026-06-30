## Plan — Gate 1,000 Homes Behind Paid $99 Plan
- [x] Find every place that grants the 1,000-home capacity or treats trial/card-on-file as equivalent to paid access.
- [x] Update the UI gate so free trial/card-on-file users cannot select or receive the 1,000-home option.
- [x] Update the backend pull/start validation so direct function calls cannot request 1,000 homes unless the $99/month subscription has actually paid.
- [x] Verify the changed behavior with static checks and a production build.
- [x] Document results and add a lesson to prevent future trial-vs-paid gating mistakes.

### Review — Gate 1,000 Homes Behind Paid $99 Plan
The 1,000-home Precision capacity now requires an active Precision/Pro subscription with `subscription_paid_confirmed === true`, which Stripe sets only after a paid invoice/paid checkout. Free trials and card-on-file accounts are capped at 50 homes in the UI and blocked in `startBatchDataPull`; direct forced-free self-test rejected 1,000 with 403 and allowed 50 with 200. `npm run build` passes.