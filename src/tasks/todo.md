## Plan — Damascus Property Benchmark v2 Phase 1 Freeze
- [x] Lock the reproducible 1,225 raw / 1,222 canonical / 619 eligible / 46 excluded / 557 review evidence result.
- [x] Diagnose movable atoms and prove the 49.11% imbalance is a partition-search failure rather than an unavoidable protected-group constraint.
- [x] Add deterministic multi-seed connected growth and neighboring-territory re-splitting without changing evidence or classification behavior.
- [x] Pass the five-way ≤15% balance gate with connected cores, protected groups, exclusive ownership, and zero outside workload.
- [x] Verify deterministic signed-path reruns and freeze the acceptance hashes.
- [x] Start Phase 2 from the unchanged 557-record review baseline.

### Review — Damascus Property Benchmark v2 Phase 1 Freeze
The frozen signed path now partitions 619 eligible doors as 112 / 124 / 124 / 120 / 139 against a 123.8 target, reducing maximum deviation from 49.11% to 12.28%. All five cores are connected, all protected groups remain intact, all 619 properties are owned exactly once, genuine islands are zero, and connector/outside/synthetic workload remains zero. Reversed-input reruns produce the same territory hash. Phase 1 is complete; Phase 2 starts with 526 of 557 review records concentrated in unresolved property use.

---

## Plan — Phase 2 Bulk Evidence Review Reduction
- [x] Freeze the unchanged 557-record review baseline and profile its deterministic evidence cohorts.
- [x] Accept the conflict-safe offline HomeData adapter without broadening classifier policy.
- [x] Verify the final transition matrix has zero eligible↔excluded flips.
- [x] Verify two clean adapter builds produce identical normalized output and hashes.
- [x] Accept the provisional result: 1,080 eligible / 33 excluded / 109 review (8.9%).
- [x] Add deterministic byte-limited tiling that preserves property/work-unit identities, classifications, protected groups, and release-scoped topology.
- [x] Pass focused packaging, adapter, release-builder, 10,000-work-unit topology, and production-build checks.
- [ ] Upload the production-authoritative Damascus v3 source artifacts to immutable R2 and re-read every hash (write credentials are not configured in this workspace).
- [x] Build twice and validate the new explicit 1,222-property source contract with byte-identical outputs.
- [x] Rerun the signed, production-equivalent five-way 1,055-door benchmark at the ≤15% maximum-deviation gate.
- [x] Freeze v3 source rules, hashes, transition matrix, tile inventory, signed manifest, and territory result.
- [ ] Run the unchanged pipeline over statewide Maryland after source retention passes.
- [ ] Sign, upload, verify, activate with rollback retained, then run live Damascus acceptance.

---

## Plan — Maryland Property-First Vertical Slice
- [x] Confirm Maryland's signed release path is the existing distribution foundation and identify the separate-road regression in the standalone Overture adapter.
- [x] Add a regional overlay that preserves normalized Maryland road identities, topology, protected groups, provenance, and tile scheme.
- [x] Make eligible property doors authoritative while retaining hard transportation-access exclusions.
- [x] Emit an old blockface versus property-level A/B report for Damascus/Olney slices.
- [x] Acquire and validate the pinned Damascus Overture slice: 1,303 addresses, 1,383 buildings, and 34 places from release `2026-07-22.0`.
- [ ] Run the overlay against exported live Maryland normalized tiles and the pinned Overture bulk files.
- [ ] Validate and sign the resulting immutable regional release with the existing offline signer.

### Current constraint — Maryland Property-First Vertical Slice
Historical Overture recovery is closed after one focused predicate/tool comparison. The explicit `2026-07-22.0` contract is now authoritative: Gates A–C pass at 1,222 properties, 1,055 eligible / 26 excluded / 141 review (11.54%), and five-way loads 240 / 199 / 200 / 198 / 218 (13.74% maximum deviation). The only Damascus Gate D blocker is durable source retention: upload the manifest-listed raw artifacts to immutable R2 and re-read their hashes before statewide publication.

---

## Plan — Restore Route Hydration Recovery Exports
- [x] Trace the runtime import error to the Knock page and shared hydration module.
- [x] Restore the missing recovery marker and cache-safety helpers with the backend marker as source of truth.
- [x] Add focused tests for recovery-limited properties and complete-route cache eligibility.
- [x] Verify every current importer resolves to an explicit shared export and both map cache paths use the cache-safety helper.
- [x] Record the verified result.

### Review — Restore Route Hydration Recovery Exports
The GitHub sync added Knock-page imports for recovery-aware hydration helpers without adding the corresponding shared exports, causing Vite to reject the module before the page could render. The shared module now exports both helpers, treats backend `recovery_limited: true` pins as visible but not cacheable, and applies the same rule to individual and collection map caches. Focused regression coverage checks limited, complete, and partial route snapshots; source verification confirms all imports now resolve.

---

## Plan — Move Rep Join + Paid Seat Path to Team Page
- [x] Inspect the Team page paid gate, invite-code redemption, billing checkout, seat update, and Stripe webhook behavior.
- [x] Add “I'm a Rep” beside “View Plans” on the paid Team gate.
- [x] Prompt reps for the manager's team code and redeem it through the existing trusted invite-code backend.
- [x] Add an “Add Seat” action on the Team Access panel that opens Stripe billing instead of granting a seat locally.
- [x] Treat unpaid/trial seat quantity as zero usable rep seats until a paid invoice is confirmed.
- [x] Update the seat-limit path to send managers to paid seat billing before they can add another rep.
- [x] Enforce the same paid-seat capacity on the backend invite redemption function.
- [x] Smoke-test invite redemption after the backend change.

### Review — Move Rep Join + Paid Seat Path to Team Page
The Team page now supports the simplest switch: unpaid users can either view plans or choose “I'm a Rep,” enter a manager's team code, and join through invite redemption. Managers now see an “Add Seat” action in Team Access, usable rep seat capacity stays at zero until payment is confirmed, and the backend also rejects invite redemption when the manager has no paid seats available. Smoke test returned the expected missing-code validation response.

---

## Plan — Refine Team Invite Language
- [x] Inspect the current manager team screen and role-selection join flow.
- [x] Rename the quick invite action from demo language to team language.
- [x] Rename the generated default invite label from “Demo Team” to “Team”.
- [x] Keep the existing invite-code redemption and seat gate behavior unchanged.

### Review — Refine Team Invite Language
The manager team screen now says “Create Team” instead of “Create Demo,” and the default generated invite label is now “Team (code)” instead of “Demo Team (code).” The current flow remains: managers create/copy an invite code, reps enter it on onboarding, and redemption links the rep to the manager account.

---

## Plan — Fix Command Center Mobile Top Cutoff
- [x] Inspect the Command Center overlay shell that renders over the map.
- [x] Identify that the overlay begins at raw viewport top without safe-area spacing.
- [x] Add mobile safe-area top padding to the full-screen overlay so its header clears the phone status/header area.
- [x] Keep the dashboard content, filters, and close action unchanged.

### Review — Fix Command Center Mobile Top Cutoff
Command Center now pads its full-screen overlay by `env(safe-area-inset-top)`, so on mobile/PWA views the title bar starts below the phone status area instead of being clipped. Dashboard behavior and content remain unchanged.

---

## Plan — Replace Home Screen Icon
- [x] Replace the static favicon/apple-touch-icon references with the requested large FirstKnock icon.
- [x] Replace the runtime metadata icon updater so it does not overwrite the home-screen icon with the old asset.
- [x] Add a web manifest icon for browsers that use manifest metadata when adding to home screen.
- [x] Bump the installed-app release key so cached icon metadata refreshes.

### Review — Replace Home Screen Icon
The old narrow wordmark icon was still used by both the static HTML and the runtime metadata updater. Both now point to the requested large square FirstKnock icon, and the app has a manifest entry for browsers that use manifest metadata during add-to-home-screen.

---

## Plan — Remove Mobile Bottom-Bar Blank Space
- [x] Identify the screenshot symptom: the bottom nav icons render above a large black reserved area.
- [x] Remove the bottom safe-area padding from the nav container because it creates visible blank space below the icons in the installed mobile shell.
- [x] Keep the app shell pinned with `inset-0` and keep the existing 64px bottom navigation row.
- [x] Bump the installed-app release key so the home-screen app refreshes cached shell assets again.

### Review — Remove Mobile Bottom-Bar Blank Space
The massive blank area below the bottom bar came from adding `padding-bottom: env(safe-area-inset-bottom)` to a nav whose icon row stayed fixed at 64px, so the padding rendered as empty black space under the icons. The nav now returns to a plain 64px bar pinned by the full-screen shell, and the PWA cache version was bumped so installed Safari/Brave launches can pick up this corrected shell.

---

## Plan — Fix Installed iOS PWA Bottom Gap
- [x] Confirm the startup HTML already includes iOS standalone viewport metadata.
- [x] Stop the runtime layout from downgrading that viewport metadata after login.
- [x] Use the real visual viewport height for the app shell instead of relying only on mobile viewport units.
- [x] Add a one-time installed-app cache refresh so Safari/Brave home-screen installs stop holding the old shell.
- [x] Preserve the same bottom navigation design and 64px button row.

### Review — Fix Installed iOS PWA Bottom Gap
The home-screen version can differ from the Base44 preview because Safari/Brave installed apps use standalone viewport sizing and can keep older cached shell assets. The app now sets a real viewport-height variable from `visualViewport`/`innerHeight`, keeps `viewport-fit=cover` intact after login, and clears stale PWA caches once for this release while keeping the nav design unchanged.

---

## Plan — Fix iOS Bottom Nav Gap
- [x] Keep the bottom navigation design and button layout unchanged.
- [x] Pin the authenticated app shell to the real viewport so iOS WebView height quirks cannot leave blank space below the nav.
- [x] Ensure the document root fills the viewport and does not create extra body space under the app.
- [x] Remove the unused bottom safe-area class from the nav container.
- [x] Verify the bottom nav remains a fixed 64px row at the bottom of the shell.

### Review — Fix iOS Bottom Nav Gap
The app shell now uses a fixed inset viewport container, and the document root is locked to full height with hidden body overflow. The bottom navigation remains the same 64px button row, but it is now anchored to the bottom of the visible app instead of allowing iOS to show a black gap underneath.

---

## Plan — Scale Header Logo Down Again
- [x] Keep the approved header bar unchanged.
- [x] Reduce only the visible logo size by another roughly 20%.
- [x] Preserve the transparent-padding crop so the mark remains centered.

### Review — Scale Header Logo Down Again
The header dimensions and actions are unchanged. The final transparent logo is now displayed in a smaller cropped frame, reducing the visible wordmark by about another 20% while keeping it centered.

---

## Plan — Use Final Transparent Logo
- [x] Keep the approved compact header bar unchanged.
- [x] Replace the header image with the newly uploaded transparent logo.
- [x] Reduce the displayed logo size by roughly 20% from the previous header sizing.
- [x] Verify the header source points to the final logo URL.

### Review — Use Final Transparent Logo
The header still uses the compact 64px bar. The brand image now points to the new transparent logo asset; its transparent padding is cropped within a fixed header-safe frame, leaving the visible wordmark about 20% smaller than the previous 220px display.

---

## Plan — Use Transparent Header Logo
- [x] Keep the compact header height unchanged.
- [x] Replace the temporary text wordmark with the uploaded transparent FirstKnock logo.
- [x] Size the transparent logo to fit inside the existing header without affecting actions.
- [x] Document the result.

### Review — Use Transparent Header Logo
The compact header remains the same height, and the header brand now uses the uploaded transparent FirstKnock logo image sized to fit within the bar without changing any header interactions.

---

## Plan — Compact Header Logo Correction
- [x] Remove the oversized logo treatment from the top header.
- [x] Make the header height match the compact bottom-bar scale.
- [x] Avoid using any logo image with an internal black rectangle by rendering the FirstKnock wordmark directly on the black header.
- [x] Keep the change design-only with navigation/actions untouched.

### Review — Compact Header Logo Correction
The header is compact again with a 64px row height, matching the bottom navigation scale. The internal-background logo image was removed and replaced with a clean FirstKnock text wordmark directly on the black header, so there is no image box/seam to fight.

---

## Plan — Enlarge Header Logo
- [x] Remove the separate FirstKnock text label from the selected header logo area.
- [x] Increase the black-background logo to roughly triple its previous size.
- [x] Adjust the header row height/padding so the enlarged logo is contained by the header and does not sit underneath controls.
- [x] Keep this design-only with no navigation or interaction changes.

### Review — Enlarge Header Logo
The header logo text label was removed, the logo icon was enlarged from 40px to 112px, and the header row now has enough height and bottom padding to contain the larger logo without the top controls overlapping it.

---

## Plan — Header Logo Seam Fix
- [x] Inspect the page/header logo source responsible for the visible top-left seam.
- [x] Replace the problematic wide logo image with a clean icon + text mark on the native black header background.
- [x] Preserve the same FirstKnock branding without adding borders or new decorative containers.
- [x] Document the result.

### Review — Header Logo Seam Fix
The top-left logo seam came from the wide image asset itself, which carried visible rectangular edges. The header now uses the clean app icon plus live text on the black header background, removing the cutoff/box edge while keeping the FirstKnock brand visible.

---

## Plan — Checklist + New Route Generation Fixes
- [x] Inspect the checklist overlay shell to find why the top header can be clipped on mobile.
- [x] Add safe-area top spacing to the checklist view without changing checklist behavior.
- [x] Trace route generation and auto-save to identify why duplicate creation can happen from rapid/repeated starts.
- [x] Add a synchronous in-flight guard so one route generation/save flow cannot start twice.
- [x] Mark newly generated saved routes with a visible “New” prefix at the save source of truth.
- [x] Document the result and lessons.

### Review — Checklist + New Route Generation Fixes
The checklist view now includes safe-area top spacing so its header no longer starts under the top of the screen. Route generation now has a ref-based in-flight guard, preventing same-tick double starts before React state updates. Newly generated saved routes are named with a visible “New —” prefix and metadata timestamp so the freshest route is easier to distinguish from existing active routes.

---

## Plan — Appointment Closest-Date Ordering
- [x] Identify the Appointments date sorting and grouped date ordering.
- [x] Change the default appointment ordering so nearest upcoming appointments show first and farthest future dates move lower.
- [x] Keep past-only view sorted with the most recent past appointment first.
- [x] Keep unscheduled items at the bottom.
- [x] Record the result.

### Review — Appointment Closest-Date Ordering
The Appointments tab now sorts visible appointments by closest upcoming date first, then later future dates, then past dates with the most recent past first, and unscheduled rows last. The date group headers follow the same order so opening Appointments no longer shows the furthest-away appointments first.

---

## Plan — Restore Callback Visibility in Appointments
- [x] Trace how callback InteractionLog rows are merged into the Appointments tab.
- [x] Identify why route/Neon-backed callbacks can be read by the system but still hidden from Appointments.
- [x] Add callback property hydration through the existing route-property lookup, not only the old MasterProperty query.
- [x] Keep every visible callback log in the Appointments list, even if property hydration is still missing, without saving fake placeholder Appointment records.
- [x] Refresh callback hydration when the Appointments page refreshes.
- [x] Document the correction pattern.

### Review — Restore Callback Visibility in Appointments
Root cause: the Appointments tab merged callback InteractionLog rows only when their property could be found in the older MasterProperty list. Callbacks tied to route/Neon properties could be readable logs but still skipped because address hydration failed. The page now hydrates callback hashes through the existing route-property lookup and still displays unreadable callback rows as display-only callbacks instead of dropping them, so each user's visible callback logs appear in Appointments.

---

## Plan — Appointment Run Opens Preferred Maps App
- [x] Find the existing Apple/Google Maps navigation helper and preference source.
- [x] Update the Appointments Run action to open the user's preferred maps app directly instead of routing through Knock mode.
- [x] Enable Run for appointments that have either coordinates or a real address, not only route-linked appointments.
- [x] Keep View Map as the FirstKnock map action and reserve Run for external navigation.
- [x] Remove the remaining `Callback address` save fallback from Knock callback appointment creation.
- [x] Record the result.

### Review — Appointment Run Opens Preferred Maps App
Appointments now use the shared navigation helper and the same `fk_navigation_app` / user `navigation_app` preference as Knock mode. Tapping Run opens Apple Maps or Google Maps directly for the appointment address/coordinates; View Map still opens FirstKnock. Run is available for any appointment with a usable address or coordinates. The last callback-creation fallback that could save `Callback address` was also removed.

---

## Plan — Stop Random Callback Appointment Backfill
- [x] Identify why appointments are being populated even though the user did not assign any.
- [x] Remove the automatic callback-log-to-Appointment database backfill.
- [x] Hide old auto-generated callback Appointment rows from the Appointments list.
- [x] Only show callback log rows when they can resolve to a real property address.
- [x] Clean up already-created auto callback appointments marked by `callback_log` notes or `Callback address`.
- [x] Record the correction.

### Review — Stop Random Callback Appointment Backfill
Root cause: the Appointments page was automatically converting every CALLBACK interaction log into a saved Appointment record, and when a property address could not be hydrated it used the fallback text `Callback address`. That created hundreds of appointment rows the user never assigned. The page no longer saves callback logs as appointments, filters out old auto-generated callback appointment rows, only displays callback-log rows when a real address is available, and removes the previously generated false callback appointments.

---

## Plan — Fix Appointment Delete Layout + Delete All
- [x] Re-check the latest appointment delete UI changes against mobile width constraints.
- [x] Move appointment card actions back into the full card width on mobile so Delete cannot run off-screen.
- [x] Make the header actions wrap into a mobile-safe grid so Delete All remains visible.
- [x] Change Delete All to attempt every shown item instead of aborting on the first failed callback/appointment delete.
- [x] Keep callback rows suppressed immediately after delete so backfill does not make them look undeleted.
- [x] Record the correction.

### Review — Fix Appointment Delete Layout + Delete All
The appointment card actions now use the full card width on mobile and only indent on larger screens, so the Delete button no longer runs off the right edge. The header action buttons use a mobile grid with shorter labels. Delete All now processes all currently shown rows, refreshes the list when finished, and suppresses callback-log rows immediately so callback backfill cannot make deleted rows appear to remain.

---

## Plan — Appointments Delete + Callback Filter
- [x] Inspect the Appointments page, appointment cards, detail modal, and callback-log merge behavior.
- [x] Add a callbacks-vs-appointments filter that separates callback-created rows from regular appointments.
- [x] Add a per-card delete action and preserve the existing detail delete flow.
- [x] Add a delete-all action for the currently shown filtered appointments/callbacks.
- [x] Prevent deleted callback logs from immediately reappearing through the callback backfill merge.
- [x] Record the result.

### Review — Appointments Delete + Callback Filter
Added source filtering to the Appointments page so users can view All, Callbacks, or Appointments. Added per-card delete plus a Delete All action for the currently shown filtered results. Callback-derived appointments now delete their linked callback log when available, and the page suppresses deleted callback logs from being immediately backfilled again during the same session.

---

## Plan — Simplify BatchData Email
- [x] Remove the complicated explanation from the escalation draft.
- [x] Keep only the exact payloads we are sending and the observed result for each.
- [x] Ask BatchData one simple question: does `intel.lastSoldDate.minDate` work with polygon geography, and if not, what exact payload should we use?
- [x] Record the correction.

### Review — Simplify BatchData Email
Simplified `src/tasks/batchdata-escalation.md` into a short support email. It now shows BatchData's city/state example, our broad polygon + 7-day payload, the stricter residential/value payload, the no-date control payload, and one simple question about whether `intel.lastSoldDate.minDate` works with `address.geoLocationPolygon.geoPoints`.

---

## Plan — Cross-Reference BatchData June 23 Reply
- [x] Compare BatchData's suggested `intel.lastSoldDate.minDate` payload against our current production polygon payload.
- [x] Determine whether the current failure looks like ignored filtering, provider zero-results, stale/off-market semantics, or app-side filtering.
- [x] Update the BatchData escalation packet with a sharper follow-up referencing their June 23 answer.
- [x] Record the result.

### Review — Cross-Reference BatchData June 23 Reply
BatchData's reply confirms the `searchCriteria.intel.lastSoldDate.minDate` path and date-only format, but only for city/state geography. Our current production request uses the same intel path with polygon geometry. The latest no-write probe proves the polygon can return inventory without the date filter, while the same polygon plus `minDate=2026-06-24` returns zero raw records before app-side filtering. Updated `src/tasks/batchdata-escalation.md` with a cross-reference section and a revised follow-up asking BatchData to confirm polygon support, field semantics, large-polygon behavior, provider lag, and the exact listing-status filter for MLS-confirmed sold listings.

---

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

---

## Plan — Paid Seat Before Rep Activation
- [x] Change every visible “Add Rep/Add Team Member” entry point to open paid seat billing instead of creating a TeamMember directly.
- [x] Keep backend invite redemption as the activation gate: reps can only join when the manager has paid-confirmed seat capacity.
- [x] Verify the invite function still deploys and rejects invalid/missing codes normally.
- [x] Document the result and lesson so future team flows never rely on frontend-only seat checks.

### Review — Paid Seat Before Rep Activation
“Add Rep” now opens seat billing instead of a manual team-member creation form, and the roster add-card now says “Add Paid Seat” and uses the same billing action. Invite redemption remains the backend activation gate: it rejects joins when the manager has no paid-confirmed rep seats, and the smoke test returned the expected missing-code validation response.

---

## Plan — Add Multiple Paid Rep Seats
- [x] Replace the direct Add Rep action with a quantity confirmation dialog defaulted to 1 seat.
- [x] Show the monthly cost estimate based on the manager’s current plan and selected quantity.
- [x] Send the selected total seat quantity to Stripe so the manager pays for the new seats before reps activate.
- [x] Stop updating available seats immediately before payment clears; rely on Stripe/payment confirmation before invite redemption sees capacity.
- [x] Verify backend validation and static wiring, then document the result.

### Review — Add Multiple Paid Rep Seats
Add Rep now opens a seat quantity dialog with 1 selected by default, plus/minus controls, and an added monthly cost estimate. Confirm sends the new total seat quantity to Stripe, and the seat update function no longer increases Base44 seats immediately; `invoice.paid` now updates `total_seats` and invite code capacity after payment clears. Static wiring checks passed, and the backend smoke test deployed successfully and returned the expected “No active subscription found” response for the test account.

---

## Plan — Fix Add Rep Routing To Plans
- [x] Remove the pre-dialog redirect that sends Add Rep to Plans before the manager can choose seat quantity.
- [x] Keep the seat quantity dialog as the first interaction after clicking Add Rep.
- [x] On confirmation, use subscription seat update for existing Stripe subscriptions and direct checkout for first-time seat purchases.
- [x] Verify static wiring so Add Rep no longer calls Billing directly.
- [x] Document the review and correction lesson.

### Review — Fix Add Rep Routing To Plans
The Add Rep click path now always opens the seat quantity dialog first. Confirmation updates an existing Stripe subscription when one exists, or starts a Stripe checkout session for first-time seat purchases, both returning to Team afterward. Static verification confirmed Add Rep no longer calls Plans directly, and the seat update backend still deploys with the expected no-active-subscription response in the test account.

---

## Plan — Correct Rep Seat Price To $99
- [x] Make the Add Rep dialog calculate every selected rep seat at $99/month.
- [x] Make first-time Stripe checkout use the $99 seat price instead of the Canvas $19 plan price.
- [x] Make existing subscription seat updates switch the subscription item to a $99/month seat price before invoicing.
- [x] Verify the UI and backend wiring both reference 9900 cents / $99.
- [x] Document the correction lesson.

### Review — Correct Rep Seat Price To $99
Rep seats now calculate at $99/month in the Add Rep dialog. First-time checkout uses the $99 Precision price instead of the $19 Canvas price, and existing subscription seat updates switch the subscription item to a $99/month rep-seat price before invoicing. Static checks confirmed the frontend and backend both reference $99 / 9900 cents, and the backend smoke test still deploys with the expected no-active-subscription response in the test account.

---

## Plan — Force Stripe Confirmation Before Seat Activation
- [x] Pass the Team return URL into the existing-seat update request.
- [x] Make the seat update backend finalize/retrieve the generated invoice and return its Stripe-hosted payment URL.
- [x] Add a Stripe billing-portal fallback if Stripe does not expose an invoice URL, so the confirm button still opens Stripe.
- [x] Verify the confirm flow always has a Stripe redirect path and still waits for webhook payment confirmation before seats activate.
- [x] Document the review and correction lesson.

### Review — Force Stripe Confirmation Before Seat Activation
Confirming seats now passes the Team return URL into the seat update request, and the backend retrieves/finalizes the generated invoice and returns a Stripe-hosted URL. If Stripe does not expose an invoice URL, it falls back to a Stripe billing portal URL so the user is still sent to Stripe. Static checks verified the frontend redirects to that URL, and seats still activate only from the `invoice.paid` webhook path.

---

## Plan — Make Appointments Account-Specific
- [x] Identify why South Carolina appointments/callbacks can appear in another account.
- [x] Add a single account-ownership filter for persisted appointments, callback logs, and reminder timers.
- [x] Keep manually-created and auto-scheduled appointments stamped with the current manager/account ID.
- [x] Verify the appointment page no longer renders global/admin-visible records.
- [x] Document the review and lesson.

### Review — Make Appointments Account-Specific
The Appointments page was using broad list reads for appointments and callback interaction logs. Because admin-readable records can include global/demo data, the page could render appointments outside the current account. The page now applies a single account ownership filter after reads: manager accounts only show records for their own manager ID, reps only show their manager's account records, and legacy unscoped rows only remain visible to the creator who made them. Manual and auto-scheduled appointments already stamp `manager_id`, and the production build passed after the change.

---

## Plan — Rep Bottom Navigation Tabs
- [x] Replace the old rep-only Knock/Help bottom nav with Knock, Analytics, Appts, and Team.
- [x] Keep the Map tab hidden for reps.
- [x] Verify the updated layout builds successfully.
- [x] Document the review and lesson.

### Review — Rep Bottom Navigation Tabs
Rep accounts now see Knock, Analytics, Appts, and Team in the bottom navigation. The Map tab remains hidden for reps, and the production build passed after the layout update.

---

## Plan — Reset Team Codes and Name Teams
- [x] Remove all existing invite/team codes across accounts.
- [x] Change the Create Team button to open a team-name prompt instead of instantly creating a code.
- [x] Create the new team code only after a team name is entered, using that name as the team label.
- [x] Verify the Team page builds successfully.
- [x] Document the review and lesson.

### Review — Reset Team Codes and Name Teams
All existing InviteCode records were removed so previous team codes no longer work. The Create Team button now opens a naming dialog, requires a team name, then creates a new rep team code using that name as the label. The JSX syntax error was fixed and `npm run build -- --mode development` passed.

---

## Plan — Keep New Team Codes Locked Until Paid
- [x] Make newly-created team codes start with zero usable seats.
- [x] Update the Team Created dialog and access-card copy so it does not say a new code is valid for 5 users.
- [x] Ensure Stripe webhook seat syncing only unlocks invite codes after paid confirmation.
- [x] Verify the frontend build passes after the changes.
- [x] Document the review and lesson.

### Review — Keep New Team Codes Locked Until Paid
New team codes now start with `max_uses: 0`, so redeeming a new code is blocked until paid seat capacity exists. The Team Created dialog no longer says the code is valid for 5 users; it tells managers the code unlocks after a paid rep seat is confirmed. Stripe webhook syncing now updates all of a manager's invite codes only after paid confirmation, and `npm run build -- --mode development` passed.

---

## Plan — Sales Live Feed
- [x] Replace the editable sales/revenue card with a read-only sales feed.
- [x] Show only sale records, including sale value, time, and who logged it.
- [x] Subscribe to new/updated/deleted sales logs so the feed refreshes live.
- [x] Verify the app builds successfully.
- [x] Document the review.

### Review — Sales Live Feed
The analytics sales card is now a read-only live feed that only shows `SOLD` interaction records for the current account/team logs. Each row shows the rep who logged it, the logged time, and the sale value. The feed subscribes to InteractionLog changes and refreshes the existing Team page query; `npm run build -- --mode development` passed.

---

## Plan — Team Role Tabs, Route Links, Compact Cards, and Test Code
- [x] Make Route Registry rows open the selected route on the map.
- [x] Hide Routes and Codes tabs from reps; reps should only see Analytics and Roster.
- [x] Keep team creators/managers able to see Routes and Codes.
- [x] Make roster cards smaller and hide active assignments until a rep card is selected.
- [x] Add a limited 0000 test team code with exactly 2 seats and no payment requirement.
- [x] Verify the app builds and test-code records are present.
- [x] Document the review.

### Review — Team Role Tabs, Route Links, Compact Cards, and Test Code
Route Registry rows now deep-link to the selected map route, reps only see Analytics/Roster, manager controls remain available to creators, roster cards are compact with active assignments in the selected-rep detail dropdown, and test code 0000 exists with a two-seat limit.

---

## Plan — Manager Role Access Correction
- [x] Inspect current Team and app-shell role checks.
- [x] Add a shared role resolver so manager/admin identity overrides stale rep app-role flags.
- [x] Apply the resolver to bottom navigation and Team page manager controls.
- [x] Verify the latest admin-with-rep-flag data shape is handled.
- [x] Record the review.

### Review — Manager Role Access Correction
The app now resolves manager access from app role, nested role data, owner status, and platform/admin role before deciding someone is rep-only. Verified the account shape with `appRole=rep` and `accountRole=admin` now resolves to manager access and manager bottom navigation.

---

## Plan — Promote Rep to Manager
- [x] Add a secure manager-only role-switch backend action.
- [x] Update the rep card with a Make Manager button for managers.
- [x] Wire the button to upgrade the rep's user account to manager status and refresh the roster.
- [x] Preserve existing paid-seat and team roster behavior.
- [x] Verify the backend action deploys and returns a safe auth response.
- [x] Record the review.

### Review — Promote Rep to Manager
Managers now get a Make Manager button on rep roster cards. Confirming it calls a backend role-switch action that verifies manager access, checks the rep belongs to the manager's team, updates the rep user account to `app_role: manager`, and updates the roster role so the promoted account regains Map and manager tools. The backend function deployed and returned a safe validation response.

---

## Plan — Manager Self Profile Card Polish
- [x] Remove the duplicate “(Manager)” text from the manager's displayed name while keeping the manager role tag.
- [x] Use the current account's saved profile photo for the manager self card.
- [x] Let the manager self card upload and save a new profile photo to the current account.
- [x] Verify the visible card logic still preserves rep photo editing and manager tags.
- [x] Record the review.

### Review — Manager Self Profile Card Polish
The manager self card now displays only the account name while keeping the MANAGER badge below it. The card reads the saved account profile photo and the camera button now uploads a new photo to the signed-in manager account; manager-controlled rep photo editing remains unchanged.

---

## Plan — Move Role Switch to Header
- [x] Remove the Make Manager action from individual rep cards.
- [x] Add a manager-only Switch Role button in the Team header.
- [x] Let managers choose which rep to switch to manager status from the header control.
- [x] Reuse the existing secure promotion backend action.
- [x] Verify the card no longer renders Make Manager and the header flow is wired.
- [x] Record the review.

### Review — Move Role Switch to Header
The rep card no longer renders the Make Manager button. The Team header now includes a manager-only Switch Role button that opens a rep picker and reuses the existing secure promotion action to switch the chosen rep to manager status.