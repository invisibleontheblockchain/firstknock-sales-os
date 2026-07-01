## Plan — BatchData Last-Week Escalation Packet
- [x] Identify the exact latest failing last-week large-area FetchJob and its selected area/request settings.
- [x] Extract the exact BatchData request payload shape from the live request-preview builder.
- [x] Document the app-side files and filters that could affect returned/stored/routeable properties.
- [x] Draft a clear escalation email to BatchData with exact parameters, expected behavior, and specific questions.
- [x] Verify the packet against current code and recent job data.
- [x] Record the result.

### Review — BatchData Last-Week Escalation Packet
Created `src/tasks/batchdata-escalation.md` with the exact latest failing job ID, area, FIPS, selected last-week date, no-write probe results, production payload, local app files/filters, and a ready-to-send BatchData email. Verification showed the latest 24,360.22 sq mi job returned `raw=0` before any app-side mapping/filtering; the same polygon without `intel.lastSoldDate.minDate` returned a stale 2024 record, proving the polygon can return inventory and the issue is specific to recent-sale/intel-date filtering or provider lag/coverage.

---

## Plan — Loosen BatchData Local Guardrails
- [x] Keep the BatchData request date/polygon targeting intact so paid pulls still ask for recent owner-change properties.
- [x] Change ingestion so BatchData-returned polygon matches are saved as routeable unless they fail only hard safety checks: invalid address/coordinates, outside drawn area, or clearly non-residential land/commercial type.
- [x] Stop preselect paging from depending on the same strict route_active gate so we do not sample rejected rows when usable provider rows exist.
- [x] Loosen exact-job candidate retrieval so it does not re-drop rows due to rejected/confidence flags from older stricter parsing.
- [x] Loosen final local route filters for BatchData exact-job/imported candidates while keeping user-configured geography, assigned-route, previously-knocked, callback, and price/year filters.
- [x] Verify with synthetic BatchData rows that previously rejected neutral/missing-sale-field records now survive, while outside-polygon/invalid rows still fail.
- [x] Record the result and lesson.

### Review — Loosen BatchData Local Guardrails
Changed the Precision BatchData path to trust the paid provider request more: production fetching now uses the broad polygon request with `intel.lastSoldDate.minDate`, ingestion saves BatchData rows as routeable unless they fail hard safety checks, exact-job candidate retrieval no longer re-drops rows because of older strict rejection/confidence flags, and the final route filter lets BatchData candidates survive repeated sold-date/confidence/SFR gates. Verification passed: synthetic BatchData rows with active listing status, missing sale fields, and old/flagged local statuses now stay routeable when inside the polygon; a commercial row remains inactive; an outside-polygon row is dropped; the latest real exact job still returns 3 active candidates; and `npm run build` passes.

---

## Plan — Check 1–2 Day Sold Records
- [x] Identify the recent BatchData jobs and their imported property rows.
- [x] Count returned homes with sale evidence within the last 1 day and within the last 2 days.
- [x] Distinguish provider-returned rows from routeable/active rows so we know whether zero is provider coverage or our filtering.
- [x] Report the result clearly.

### Review — Check 1–2 Day Sold Records
Checked the latest baysecurity BatchData Precision jobs plus the stored rows updated since `2026-06-30T23:00:00Z`. The corrected Neon diagnostic checked 16 recently updated workspace rows and found `sold_1_day_count=0` using cutoff `2026-06-29`, and `sold_2_day_count=0` using cutoff `2026-06-28`. The sale dates that actually came back were `2026-06-24`, `2026-06-23`, `2026-06-18`, `2026-06-17`, and `2026-06-16`. This means the recent pulls did not receive any homes sold in the last 1–2 days; the available provider evidence is older, with the freshest stored row dated Jun 24.

---

## Plan — Diagnose East-Coast Zero Precision Pull
- [x] Inspect the latest 155k sq mi FetchJob and its processor logs.
- [x] Add a no-write raw BatchData probe that fetches one small page and reports raw rows, mapped rows, active rows, and sale/status fields.
- [x] Probe exact sold-date request and polygon-without-sold-date request to isolate whether the date filter or app-side filtering is responsible.
- [x] Patch only if the evidence shows our mapper/request is dropping usable properties.
- [x] Document the result and the root cause.

### Review — Diagnose East-Coast Zero Precision Pull
Root cause: BatchData did return properties for the 155,585.63 sq mi east-coast job, but our side silently filtered them out. Job `6a4457023615809c140a8a19` originally received 3 raw strict rows and 4 broad rows, all with `intel.lastSoldDate = 2026-06-23T00:00:00.000Z` and residential `R2` land use, but the mapper compared those midnight dates against a rolling `now - 7*24h` timestamp. Because the job ran late on Jun 30, Jun 23 midnight was treated as a few hours too old even though it matched the exact `minDate: 2026-06-23` sent to BatchData. I changed ingestion and Neon candidate retrieval to use job-anchored calendar-date cutoffs, reprocessed the affected job, and verified it now stores `raw=3`, `mapped=3`, `active=3`; owner-scoped candidate retrieval returns 3 active homes; `generateRoutesBackend` creates 1 route with 3 homes.

---

## Plan — Verify BatchData Sold-Date Payload
- [x] Find the latest matching Anderson-area Precision job/polygon.
- [x] Generate the outbound BatchData request preview from the live backend builder.
- [x] Confirm it uses `searchCriteria.intel.lastSoldDate.minDate` with the exact selected 1-week window.
- [x] Confirm property caps and confirmed-sale post-filtering remain in place.
- [x] Document the result and only patch if the live payload differs.

### Review — Verify BatchData Sold-Date Payload
The matching Anderson-area jobs are `6a4454d77e067b5d1cd2559b` and `6a4454bae2c208ca0c269325`, both 301.35 sq mi, `sold_months=0.25`, requested count 2. The live backend request preview sends `searchCriteria.intel.lastSoldDate.minDate = "2026-06-23"` under `searchCriteria`, with polygon points under `address.geoLocationPolygon.geoPoints`, `options.take = 100`, and no dataset scoping. Strict mode adds residential land use and min value; broad mode removes those extra filters but keeps the same `intel.lastSoldDate` filter. The completed job logs show BatchData returned zero raw rows for both strict and broad modes, so there was no app-side off-market rejection on these two jobs. A live no-write refetch against the same polygon timed out, so I stopped that path rather than retrying an expensive duplicate provider call. No code patch was needed because the live payload already matches BatchData's recommended `intel.lastSoldDate.minDate` structure.

---

## Plan — Remove Precision Square-Mile Cap
- [x] Remove backend square-mile and span rejection from live Precision pull starts.
- [x] Remove old area-limit metadata from Precision previews so only property caps remain.
- [x] Keep existing property caps and paid-plan gates unchanged.
- [x] Verify a large dry-run no longer returns `area_too_large` and build still passes.
- [x] Document the correction and lesson.

### Review — Remove Precision Square-Mile Cap
Precision pulls no longer reject by square miles or width/height span. `startBatchDataPull` now allows a 1,169,994.86 sq mi dry-run and returns success, while the self-test free account still rejects 1,000 requested properties with the paid Precision gate. `previewBatchDataArea` now reports `max_area_sq_mi: null` and `max_allowed_span: null`, with property caps still intact. `npm run build` passes.

---

## Plan — Diagnose Huge-Area Last-Week Zero Pull
- [x] Inspect the newest huge-area 1-week FetchJob: area, polygon size, requested count, provider attempts, and routeable count.
- [x] Compare exact last-week, 2-week, and no-date provider probes on the same shape to separate date-window coverage from geometry/API limits.
- [x] Check whether the requested property count or route-start handoff can make a huge area look empty even when provider data exists.
- [x] Patch the smallest root cause if the app is under-querying, misreporting, or using a provider-incompatible shape.
- [x] Verify with backend status/probe/build checks and document the result.

### Review — Diagnose Huge-Area Last-Week Zero Pull
The latest pull was 573,337.11 sq mi with 36 polygon points, `sold_months=0.25`, requested count 2, and provider returned 2 raw records. Both raw records were rejected by the routeability gate, so the old backend incorrectly stopped and showed zero routeable properties. I changed BatchData fetching so requested count means routeable homes wanted: it now pages through provider results up to a safe review cap, maps/filter-checks records, and only stops when it finds routeable records or exhausts the provider set. A no-write preview against the same giant polygon now finds 1 active routeable property instead of 0. I also enforced the existing Precision area/span limits in `startBatchDataPull`; the app now rejects oversized Precision draws up front instead of sending provider-incompatible 573k sq mi polygons. Verification: huge dry-run returns `area_too_large`, no-write routeability preview works, and `npm run build` passes.

---

## Plan — Re-check 500 Sq Mi Last-Week Zero Pull
- [x] Inspect the newest 1-week FetchJob and confirm its exact area, request settings, provider attempts, and active count.
- [x] Compare strict polygon vs broad polygon behavior to determine whether the zero is provider-side or caused by our filters.
- [x] Check for a polygon/request-shape issue that could make a large drawn area under-query BatchData.
- [x] Patch the smallest root cause if the request is malformed or too restrictive.
- [x] Verify with backend request previews/status checks and record the result.

### Review — Re-check 500 Sq Mi Last-Week Zero Pull
The newest drawn-area pulls were 470.74 sq mi with 34 polygon points, exact `sold_months=0.25`, and requested counts of 1-2. Both production attempts returned zero: strict polygon 0 and broad polygon 0, with `active_count=0`. A no-write production BatchData probe against the same polygon proved the polygon itself works: no date filter returned 100 records, 2-week `intel.lastSoldDate.minDate=2026-06-16` returned 10 records, and exact 1-week `minDate=2026-06-23` returned 0 records. So the issue is provider-side sale/intel recency lag, not area size, polygon geometry, route filtering, or stale-data reuse. I updated the zero-result route message for ultra-recent pulls to explain BatchData-confirmed sale lag and recommend 2 weeks or 1 month. `npm run build` passes.

---

## Plan — Diagnose Short-Window Precision Pulls
- [x] Inspect latest 1-day/2-day/1-week/2-week FetchJob settings and counts.
- [x] Compare provider request dates against stored raw/mapped/active results.
- [x] Determine whether short windows are failing at BatchData response, ingestion mapping, or final route filter.
- [x] If the cause is in our code, patch the smallest root cause; if provider coverage is the cause, surface a clear product explanation.
- [x] Verify with backend previews/data checks and record the result.

### Review — Diagnose Short-Window Precision Pulls
The 1-week failure is not from the local route filter anymore. The latest 1-week, 1,929.71 sq mi exact polygon pull sent `intel.lastSoldDate.minDate = 2026-06-23`; BatchData returned 0 for both strict polygon and broad polygon. The same area at 2 weeks returned 2 active homes, whose sold dates are Jun 18, which is outside 1 week but inside 2 weeks. Earlier 1-day/1-week jobs showing Jun 18 were from the now-removed widened request behavior. I also removed the centroid fallback from production Precision polygon pulls and request previews so a failed polygon request no longer reports unrelated center-point records. `fetchJobStatus` confirms the latest 1-week job has `active_count: 0`, and `npm run build` passes.

---

## Plan — Use Exact Sold-Date Request Windows
- [x] Remove provider-side minimum sold-date widening from the live BatchData pull request.
- [x] Remove matching route-candidate widening so exact-job retrieval follows the selected timeframe.
- [x] Verify request previews for 1 day, 2 days, and 1 week send exact `intel.lastSoldDate.minDate` values.
- [x] Run build/backend checks and document the correction.

### Review — Use Exact Sold-Date Request Windows
The live Precision data request now sends the exact selected timeframe to `intel.lastSoldDate.minDate`: 1 day sends 2026-06-29, 2 days sends 2026-06-28, and 1 week sends 2026-06-23 on the current Jun 30, 2026 clock. The route-candidate query now uses the same exact selected window instead of a provider-safe minimum. `processFetchChunk` request previews and `npm run build` pass.

---

## Plan — Keep Visible Last-Week Filter Strict
- [x] Separate provider-safe acquisition window from user-facing route/display filter.
- [x] Patch the final local route filter so “last week” means exactly 7 days on screen.
- [x] Verify Jun 17, 2026 is excluded from a Jun 30, 2026 one-week local filter while the broader provider pull remains unchanged.
- [x] Run build verification and record the correction.

### Review — Keep Visible Last-Week Filter Strict
The broader 14-day window belongs only to provider acquisition so BatchData can return deed-lagged recent-sale evidence. The user-facing route/display filter now uses the exact selected range, so “last week” is strictly 7 days. Verification with a Jun 30, 2026 clock excludes Jun 17 and Jun 18 sold dates, while Jun 24/Jun 29 dates pass. The no-match message now says the sampled dates are outside the selected range instead of implying sold dates are missing. `npm run build` passes.

---

## Plan — Prove Why 890 Sq Mi Precision Pull Returns Too Few Homes
- [x] Inspect the latest Precision pull settings, provider/job counts, and active candidate counts.
- [x] Trace the exact filters in order: sold-date window, home-value minimum, provider cap, area geometry, and final local route filters.
- [x] Identify whether the system is under-fetching before filters, filtering too early, or failing to page until 2 eligible homes are found.
- [x] Patch the smallest root cause so a request for 2 homes in a large area searches enough records to satisfy the final filters.
- [x] Verify with the latest job/settings and record the result.

### Review — Prove Why 890 Sq Mi Precision Pull Returns Too Few Homes
The latest pull did send the intended settings: 884.52 square miles, fixed count 2, minimum value $100k, and “sold in the last week.” The data was not missing: the latest job has two active BatchData-confirmed homes, both over $100k, with sold dates on 2026-06-17 and 2026-06-18. Candidate retrieval returns both homes, and direct route generation creates one Precision route with 2 homes. The failure was the already-patched final route filter still treating the 1-week selection as a strict 7-day cutoff while ingestion/candidate retrieval correctly used the provider-safe 14-day effective window.

---

## Plan — Fix Final Route Filter Rejecting Fresh Precision Homes
- [x] Inspect the final local route filter that emits “No homes sold in last 0.25 months.”
- [x] Compare its date-window logic against the ingestion and exact-job candidate query windows.
- [x] Patch only the final filter so 1-week Precision pulls use the same effective provider-safe window already used upstream.
- [x] Verify the latest two-home pull passes the filter and does not regress the existing imported-candidate fallback.
- [x] Record the review and lesson.

### Review — Fix Final Route Filter Rejecting Fresh Precision Homes
The backend pull and exact-job candidate query were fixed, but the final frontend route filter still hard-coded `0.25` months to 7 days. The latest two active homes had valid `sold_date` values on 2026-06-17 and 2026-06-18, which are inside the provider-safe 14-day pull window but outside the old final 7-day route filter, causing the “No homes sold in last 0.25 months” error. I changed the local route filter to use the same effective sold-date window mapping as ingestion and candidate retrieval. Verification: the actual filter now treats `0.25` as 14 effective days, keeps both latest homes through every route-filter stage, and `npm run build` passes.

---

## Plan — Fix Route Generation Still Failing After Successful Precision Pull
- [x] Compare the pasted working processor behavior to the live processor and identify behavior differences that affect routeability.
- [x] Inspect the latest completed FetchJob counts and logs to determine whether homes are lost during provider fetch, local mapping, Neon write, candidate query, or route generation.
- [x] Verify the exact-job route candidate query using the latest failed job and diff the result with and without the suspected downstream filters.
- [x] Patch the smallest root cause so route generation uses the same confirmed-sale window as ingestion and remains exact-job scoped.
- [x] Re-test backend self-checks, latest-job candidate retrieval, and synthetic/preview behavior.
- [x] Record the review and lesson from this correction.

### Review — Fix Route Generation Still Failing After Successful Precision Pull
The latest pull was not failing at ingestion: FetchJob `6a444b4051b572e37576ab49` completed with `raw=2`, `mapped=2`, `active=2`, and debug showed both rows active. The generation failure happened one step later because `getRouteCandidatesFromNeon` recalculated the sold-date filter as `sold_months * 30`, so a 1-week pull still filtered candidates to about 7.5 days while ingestion now correctly uses a 14-day provider-safe minimum. That made exact-job candidates return `0` even though active homes existed. I updated the exact candidate query to use the same recent-window helper as ingestion. Verification: the latest exact job now returns 2 route candidates with `sold_months=0.25`, the prior 50-home job now returns 4 candidates, and `generateRoutesBackend` creates 1 Precision route from the latest two homes.

---

## Plan — Fix Latest Precision Pull Returning Zero Raw Records
- [x] Inspect the latest real FetchJob payload and confirm whether failure is before mapping, during mapping, or route-candidate selection.
- [x] Run no-write provider probes against the exact failed polygon with progressively looser request shapes.
- [x] Patch only the smallest production request issue that prevents BatchData from returning fresh homes.
- [x] Verify against the latest failed polygon and exact-job route-candidate path.
- [x] Record the review and add a lesson from this correction.

### Review — Fix Latest Precision Pull Returning Zero Raw Records
The latest real pulls were failing before routing: BatchData returned `raw=0` for the exact 7-day request, so no properties ever reached Neon. A no-write provider probe on the same failed polygon showed the area returns homes at a 14-day `intel.lastSoldDate` window, and those rows often have `intel.lastSoldDate` plus residential land use but no listing status or sale amount. I changed the production pull request to use a 14-day minimum lookback for ultra-recent ranges and changed the mapper to treat neutral BatchData `intel.lastSoldDate` rows as confirmed sale evidence while still rejecting explicit active/for-sale/off-market/pending/withdrawn statuses and non-residential land use. Verification: request preview now sends `minDate=2026-06-16` for a 7-day pull, the failed polygon probe returned live rows at that window, synthetic mapping activates neutral `intel.lastSoldDate` records and rejects pending records, and the exact-job candidate path was already confirmed to have no stale fallback rows.

---

## Plan — Fix Zero Active Properties After Confirmed-Sales Gate
- [x] Inspect current failed pulls to confirm whether BatchData returns no records or records that the mapper rejects.
- [x] Add a no-write raw-shape diagnostic so we can verify the provider response fields without creating properties/routes.
- [x] Patch only the mapper/request logic needed to recognize confirmed sales while still rejecting off-market non-sales.
- [x] Verify with live no-write preview, synthetic map tests, and exact-job route candidate checks.
- [x] Record the review and lesson.

### Review — Fix Zero Active Properties After Confirmed-Sales Gate
Failed pulls were not empty: recent jobs fetched and mapped BatchData records, but every row was rejected because `options.datasets: ['basic','listing','deed','owner']` caused the live response to omit the `intel`/`sale` fields used by the confirmed-sale gate. A no-write live preview proved the same polygon returned `active=0` with scoped datasets and `active>0` when dataset scoping was omitted. I removed dataset scoping from production BatchData requests while keeping the 100-record page limit and the confirmed-sale/off-market rejection gate. Verification: request preview now shows no dataset scope and `take: 100`; live no-write preview returned active rows with `intel`/`sale` evidence before the diagnostic hook was removed; synthetic tests still reject off-market/no-evidence rows.

---

## Plan — Fix Confirmed-Sales Precision Pull Regression
- [x] Compare current `processFetchChunk` behavior to commit `0d1fd07` and identify what still differs in live behavior.
- [x] Verify with synthetic records that off-market, pending, blank-status/no-price, and active rows are rejected while sold/closed/settled or paid-deed rows remain eligible.
- [x] Inspect the post-import route candidate path so rejected rows cannot be reintroduced from Neon/older territory queries.
- [x] Patch the smallest root cause and update diagnostics so the job reports active vs rejected clearly.
- [x] Re-test the mapper and route-candidate path, then document the result and lesson.

### Review — Fix Confirmed-Sales Precision Pull Regression
The commit `0d1fd07` ingestion gate was present and correctly rejected off-market/pending/blank-status rows unless they had sold/closed/settled status or paid sale evidence. The remaining bug was downstream in `getRouteCandidatesFromNeon`: exact BatchData job candidates were being force-reactivated even when ingestion stored them as `REJECTED` with `route_active=false`. I removed that override so route candidates must stay `route_active=true` and not have rejected workspace/property statuses. Verification: synthetic mapper test kept rejected off-market/pending rows inactive, static checks confirmed no exact-job override remains, and a real completed pull with 50 rejected rows now returns 0 route candidates.

---

## Plan — Remove Generate Option Button
- [x] Locate the selected map toolbar action button and identify only the Generate branch.
- [x] Change the drawn-area action to always open Pull Data instead of showing/running Generate.
- [x] Verify the build and record the result.

### Review — Remove Generate Option Button
The selected map toolbar action no longer shows or triggers Generate after an area is drawn. It now always opens Pull Data for a drawn area, while still keeping Draw available when no area exists. `npm run build` passes and static checks confirmed the Generate label/action is gone from that control.

---

## Plan — Verify Recent Sold Precision Pulls
- [x] Trace fixed-count and Max Available selections from the pull panel into the backend start job.
- [x] Inspect the actual BatchData search payload for 1 day, 2 day, 1 week, and 2 week windows.
- [x] Patch only the broken payload/count-mode handling needed for BatchData compatibility.
- [x] Verify generated payloads for all four recent windows in both fixed and max-available modes.
- [x] Run build/backend self-checks and record the result.
- [x] Add a lesson for provider payload field compatibility.

### Review — Verify Recent Sold Precision Pulls
The front end was correctly sending `sold_months`, fixed vs Max Available mode, and the requested cap into `startBatchDataPull`. The live processor was failing because it sent `options.take: 500`, and BatchData rejects anything over 100. I changed the processor to page requests in batches of 100 while still continuing until the fixed count or max-available plan cap is reached. Verification confirmed 1 day, 2 day, 1 week, and 2 week windows produce the expected `intel.lastSoldDate.minDate` values for both fixed and Max Available modes, all with `take <= 100`; dry-run starts passed for fixed 10 and Max Available 1000, and `npm run build` passes.

---

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