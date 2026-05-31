# Plan

## Current Plan — Move Canvas/Precision Toggle to Top Bar
- [x] Move the existing Canvas/Precision mode buttons into the main top toolbar on mobile and desktop.
- [x] Remove the separate second-row Canvas/Precision pill under Routes/Builder.
- [x] Keep existing mode-switch behavior, icons, and active-state colors unchanged; use compact CAN/PRE labels only on mobile to fit the top bar.
- [x] Verify the Home runtime does not show a new UI/build error after the move.

## Previous Plan — Canvas Zone Visual Split Bug
- [x] Diagnose why Canvas Deploy saves assignments but does not render split zones on the map.
- [x] Fix the render loop warning by using stable empty query defaults in the Canvas panel.
- [x] Generate simple zone polygon geometry client-side from the drawn territory and rep count.
- [x] Render the split zones directly in the map interface during Canvas planning/deploy via the existing map draw tool, avoiding further Home growth.
- [x] Persist zone geometry in CanvasSession so deployed territories can be reloaded visually.
- [ ] Verify in runtime logs that the render loop is gone and no new map errors appear.

## Previous Plan — Canvas Builder MVP
- [x] Replace the Canvas builder panel with a Canvas-only workflow: draw/redraw territory, session name, rep count, auto zones, assignment, auto-assign, deploy, and save territory.
- [x] Keep Precision builder controls exactly where they are and only show them in Precision Mode.
- [x] Avoid sold filters, data-pull controls, route-size controls, routing behavior, and templates in Canvas Mode.
- [x] Verify Canvas mode renders without build/runtime errors and document the result.
- Re-plan: Home is now over the safe edit limit, so saved-territory loading stores the polygon and refreshes the map instead of adding another Home listener.

## Previous Plan — Canvas Mode + Precision Pricing Split
- [x] Confirm pricing copy before implementation: Canvas Mode is priced per rep, while Precision Mode should show a remaining property-usage counter.
- [x] Add a clear app-level mode indicator on Home so users always know whether they are in Canvas or Precision.
  - Re-plan: direct Home edits are blocked by file size, so mode state/tagging was handled in smaller shared components/helpers via localStorage and route-generation helpers.
- [x] Add Canvas as a separate Builder mode while reusing the existing route-builder flow, route save flow, assignment flow, Route Command panel, Knock tab, and Checklist tab.
- [x] Keep Precision tied to paid BatchData property acquisition; keep Canvas optimized for high-volume door-knocking teams without requiring paid BatchData pulls.
- [x] Tag newly created Canvas routes distinctly so managers/reps can understand which mode produced them without breaking existing saved routes.
- [x] Make Knock and Checklist stay on the same route/order/status frequency by sharing the selected route ID, reacting to SavedRoute updates, and refreshing route/log data automatically when switching tabs.
  - Re-plan: 5-second polling caused rate-limit risk; kept SavedRoute/InteractionLog subscriptions plus focus refetch instead of constant polling.
- [x] Update Billing copy/cards to explain Canvas vs Precision, pricing intent, what each includes, and when a customer should choose each.
- [x] Verify with runtime logs/backend tests: Canvas mode backend route naming works, no new frontend compile error appeared in runtime logs, and aggressive polling was removed after detecting 429 risk.
- [x] Document final results in Review before marking complete.

## Current Plan — Freehand Save + Paid BatchData Pull
- [x] Diagnose why a fresh freehand drawing disappears instead of staying active.
- [x] Fix only stale restored polygon cleanup so newly drawn shapes are not cleared.
- [x] Confirm sandbox approval does not populate properties by design; it only validates/estimates.
- [x] Inspect the existing BatchData processor branch before wiring a paid pull button.
- [x] Add a clear paid-pull action after sandbox approval that creates a real FetchJob.
- [x] Verify backend and runtime behavior, then document results.

## Previous Plan — Queried Area History Cleanup
- [x] Stop saving drawn polygons as previous areas until a sandbox preview/query succeeds.
- [x] Keep unqueried draft/current shapes from appearing as ghost history on the map.
- [x] Add a trash control on previous areas so users can delete one saved area without clearing all history.
- [x] Re-plan around the Home file size limit by moving stale polygon cleanup into TerritoryPrompt.
- [x] Verify the touched map flow and document the result.

## Current Plan — Freehand BatchData Preview + RentCast Removal
- [x] Confirm scope before implementation: this phase should not spend paid BatchData credits; it should replace the old circle/square preset UI with freehand drawing plus a property-count/limit preview.
- [x] Define the UX: user taps Draw, freehands a polygon, then chooses requested property count after the area is drawn.
- [x] Remove the visible Circle/Square and 5/40/300 sq mi controls from the Builder draw prompt.
- [x] Add requested-property controls capped by account type: free users max 50, paid/admin users max 1000.
- [x] Enforce the same caps server-side, never trusting the frontend.
- [x] Add hard oversized-area protection before any BatchData call: reject massive polygons by area/bounding size and show a clear redraw message.
- [x] Update preview behavior to return safe metadata: area, max allowed properties, requested properties, eligibility/rejection reason, and estimated/property cap without charging BatchData.
- [x] Keep actual paid BatchData pulling disabled for now; do not wire live paid BatchData record retrieval until explicitly approved.
- [x] Verify with backend tests for free cap, paid cap, oversized area rejection, and no active RentCast processor usage.
- [x] Document results in this Review section before marking complete.

## Previous Plan — BatchData-Only Migration + Phase 1 Gate
- [x] Confirm no implementation starts until this plan is approved: Phase 1 BatchData Precision must be correct before Canvas/Phase 2 work begins.
- [x] Inventory every RentCast dependency: `processFetchChunk`, `fetchAreaProperties`, `routeFilterPipeline`, Neon schema, route generation, saved route hydration, analytics, diagnostics/test functions, docs, env vars, and UI labels.
- [ ] Freeze/preserve Kevin data first: export Kevin/Reif Environmental user, team member, saved routes, route hashes, interaction logs, workspace property links, and raw property records before any purge or migration.
  - Resolved: original safety audit used the plural typo `kevin@reifenvironmentals.com`; correct protected account is `kevin@reifenvironmental.com`.
  - Confirmed protected: Upper Mount P, Middle Mount P, and Lower Mount P are ACTIVE, assigned to Kevin Reif, and included in the migration audit must-keep list before any purge or cutover.
- [ ] Build a purge plan that removes false-positive legacy RentCast/MLS-derived records while protecting Kevin’s saved routes, knocked history, and any records still referenced by SavedRoute/InteractionLog.
- [ ] Define Phase 1 vs Phase 2 semantics in-app: Phase 1 = BatchData deed-confirmed Precision data pull; Phase 2 = Canvas Mode GPS door logging with zero BatchData dependency.
- [ ] Replace RentCast Phase 1 completely: BatchData county/FIPS-based property search, BatchData field normalization, `data_source='batchdata'`, listing/deed/owner mapping, active-listing suppression, owner-occupied filtering, corporate/investor filtering, SFR filtering, and sold-window filtering.
  - In progress: added a guarded `provider='batchdata'` / `phase='batchdata_precision'` processor branch with BatchData normalization and route-active rejection rules; not yet wired as the default live pull path.
- [ ] Remove old RentCast Phase 2 MLS gap-fill from the Precision pipeline; no MLS/listing-only route candidates should survive unless they come from BatchData fields and pass the same proof filters.
- [ ] Update `FetchJob` model for BatchData: keep polygon input for now only as the selected area boundary, add/confirm `fips_code`, `area_sq_mi`, `polygon_hash`, `provider`, `mode_tag`, estimated record count, estimated cost, and dry-run metadata.
- [ ] Replace radius/sub-circle mechanics with freehand-area mechanics: compute area, centroid, county/FIPS coverage, hash, and hard reject oversized areas instead of clipping or silently expanding.
- [x] Add a no-cost dry-run path for custom/freehand draws: user can draw, see square miles, counties/FIPS, estimated BatchData request size/cost, and allowed limits without creating a paid FetchJob or consuming records.
- [x] Solve “whole continental US” risk: server-side area caps, county-count caps, estimated-record caps, monthly credit caps, hard rejection before API calls, and clear user messaging.
- [x] Build the cost model: BatchData base plan, per-record/overage assumptions, deed/listing/owner add-on costs, dry-run vs paid pull behavior, gross margin at $99 Precision, and separate Canvas $19/rep zero-BatchData model.
- [x] Validate BatchData API response shape safely using sandbox/test calls first: capture representative raw payloads, map every field to existing app fields, and document fields that no longer exist or need fallback.
  - Verified: `setupNeonPropertyTables` added BatchData columns/indexes; `validateBatchDataShape` sandbox probe returned 3 records and mapped expected fields. Sandbox data is synthetic, but response shape is usable.
- [ ] Add migration verification: compare BatchData candidates against known-good Kevin/current routes, check route counts before/after, confirm no saved route hydrates to fewer houses, and prove false-positive RentCast records are excluded.
- [ ] Only after Phase 1 passes: begin Canvas design around mode switch, freehand draw, rep zones, GPS door logs, offline queue, and manager heatmap with no BatchData calls.
- [ ] Final cutover gate: disable RentCast env/use paths, remove RentCast UI/docs language, run runtime logs, run backend tests, confirm active jobs are idle, and document review before purging legacy data.

## Previous Plan — Builder Single Shape + Square Area Fix
- [x] Trace how Builder places circle/square territory polygons from map taps.
- [x] Ensure each new placement replaces the existing draft/confirmed territory instead of accumulating multiple circles.
- [x] Correct square dimensions so 40 and 300 square-mile selections create true area-sized squares.
- [x] Verify runtime logs and document the result.

## Previous Plan — Persist Incomplete Import Dismiss
- [x] Identify why the incomplete import prompt reappears after dismiss.
- [x] Remember dismissed failed import jobs locally by job ID.
- [x] Keep Retry behavior unchanged for users who choose to resume.

## Previous Plan — Compact Territory Drawing Prompt
- [x] Move the drawing prompt away from the center of the map.
- [x] Reformat controls into a smaller horizontal layout.
- [x] Reduce panel height/visual weight so the 300 sq mile circle remains visible.

## Previous Plan — Rep Map Close Button Responsiveness
- [x] Make the map close button respond immediately on press instead of waiting for click delay.
- [x] Stop map touch events from stealing the close button tap.
- [x] Slightly enlarge the button for easier mobile tapping.

## Previous Plan — Property Detail Close Button
- [x] Increase the close button tap target so it is easier to click on mobile.

## Previous Plan — Knock Tab Black Header Seam
- [x] Remove the faint divider line under the FirstKnock app header on the Knock tab.
- [x] Normalize the Knock tab top/background blacks so the screen reads as mostly black.
- [x] Verify with runtime logs and document the result.

## Previous Plan — Route Tab Account/Route Handoff
- [x] Persist the currently active manager route before the user opens the Knock/Route tab.
- [x] Prevent stale selected route IDs from another account from being accepted in RepHome.
- [ ] Stop Home route hydration from setting equivalent state repeatedly and triggering the maximum-update-depth loop after splitting Home.
- [x] Verify runtime logs and document the result.

### Re-plan note
- Direct Home edits are blocked because the page has grown past the safe edit limit, so the account/route handoff fix is being applied through smaller components first.

## Previous Plan — About Scroll + Contact Email
- [x] Fix the About page container so the full page can scroll inside the app shell.
- [x] Replace the Contact page support email with firstknockhelp@gmail.com in both the visible text and mail link.
- [x] Verify runtime logs and document the result.

## Previous Plan — Faster FirstKnock Map Zoom Range
- [x] Increase zoom step distance so each pinch/two-finger zoom changes more area.
- [x] Preserve the smoother zoom animation/tile behavior from the previous tuning.
- [x] Verify runtime logs and document the result.

## Previous Plan — Smooth FirstKnock Map Zoom
- [x] Tune only the Rep FirstKnock map zoom settings.
- [x] Smooth pinch/wheel zoom without changing pins, route order, GPS, or selection behavior.
- [x] Verify runtime logs and document the result.

## Previous Plan — FirstKnock Map Zoom Snap
- [x] Trace the View on FirstKnock Map handoff from property detail into the map overlay.
- [x] Identify which map effect is re-centering or refitting after user zoom.
- [x] Make the FirstKnock map support safe over-zooming instead of snapping back at the default tile limit.
- [x] Verify runtime logs and document the result.

## Previous Plan — Rep Performance Graph Overflow
- [x] Keep the performance trend chart inside its card on narrow/mobile app views.
- [x] Tighten chart margins and axis widths so Knocks and Conv % labels do not clip or overflow.
- [x] Keep chart data numeric and readable without changing the underlying metrics.
- [x] Verify runtime logs and document the result.

## Previous Plan — Builder Tap-to-Select Zoom Guard
- [x] Trace the tap-to-confirm/select area viewport behavior.
- [x] Prevent confirmed-area selection from fitting to oversized bounds or zooming out.
- [x] Keep the confirmed area visible without changing the user’s current zoom level.
- [x] Re-plan around Home file size limit by guarding Leaflet fit calls in a smaller map helper.
- [x] Verify runtime logs and document the result.

## Previous Plan — Builder Custom Area Active Bar
- [x] Make the Custom Area Active toolbar fit within mobile width without clipping.
- [x] Keep the data pull and fill-gaps actions readable/tappable on phones.
- [x] Stop Builder from re-entering area redraw/confirm mode when a confirmed area already exists.
- [x] Verify runtime logs and document the result.

## Previous Plan — Optimize Button Must Not Zoom Map
- [x] Trace the optimize button, re-optimize handler, and map fit controller.
- [x] Prevent mobile/tablet pointer/touch bubbling from reaching Leaflet map gestures.
- [x] Add a short no-fit guard around re-optimization so route-order updates cannot trigger map fit/zoom.
- [x] Verify runtime logs and document the result.

### Re-plan note
- Direct Home edits were blocked because the file is over the safe edit limit, so the fix was localized to the optimize button and shared map controller instead of expanding the oversized Home page.

## Previous Plan — Mobile FirstKnock Map Zoom/Tap Responsiveness
- [x] Remove the React Fragment warning that is spamming one warning per pin render.
- [x] Move dense route/pin/GPS vector drawing onto Leaflet canvas to reduce SVG DOM work during zoom.
- [x] Tune the mobile map and tile layer animation settings for smoother pinch zoom.
- [x] Make map buttons and invisible pin targets more responsive to thumb taps.
- [x] Verify runtime logs after the responsiveness changes and document the result.

## Previous Plan — Mobile FirstKnock Map Performance
- [x] Remove always-on house number labels from every pin and show the label only when a pin is tapped.
- [x] Decouple live GPS updates so the property pin layer does not redraw on every location heartbeat.
- [x] Use a single active tile layer instead of stacking satellite plus labels on mobile route view.
- [x] Add an invisible thumb-sized hit area around each pin while keeping the visible pin size unchanged.
- [x] Verify runtime logs after the map changes and document the result.

- [x] Inspect current map settings, data status/settings, checklist navigation, and knock tab navigation preference usage.
- [x] Identify why Apple/Google Maps preference is not consistently applied in both checklist and knock flows.
- [x] Remove the unwanted builder auto-build/generate behavior from map/settings controls.
- [x] Clean up data/map settings labels and controls with minimal UI changes.
- [x] Verify runtime logs show no new errors after changes.

## Current Plan — Cancel Active Data Import
- [x] Locate the data import progress UI and active FetchJob polling flow.
- [x] Add a backend cancel function that marks the current user's active job as cancelled and releases job locks.
- [x] Make the chunk processor respect cancelled jobs before writing/scheduling more work.
- [x] Add a Cancel button to the import overlay and stop polling locally after cancellation.
- [x] Verify status flow and document the result.

## Current Plan — Map/Builder + Mobile Route Command Bugs
- [x] Prevent the bottom Map tab from opening or leaving open Builder/Generate panels.
- [x] Keep the Route Command “New Routes” tab from auto-opening unless Builder mode is active.
- [x] Fix Route Command mobile width/overflow so cards and headers stay inside the screen.
- [x] Stop mobile close/X taps from bubbling into map gestures that trigger the zoom bug.
- [x] Verify touched UI paths and document the result.

## Current Plan — Merge Mode Mobile Polish
- [x] Keep the section arrow visible when Select to Merge is active on mobile.
- [x] Make merge checkboxes easier to see/tap on mobile.
- [x] Slightly reduce route card height across Route Command screens.
- [x] Verify runtime logs after the UI polish.

## Previous Plan — Route Command Mobile Optimization
- [x] Make the Route Command shell/header mobile-safe without changing route behavior.
- [x] Reflow the Active/Queued header actions so Delete All and merge controls stay visible on small screens.
- [x] Reflow Queued route cards so route count/status/actions stay inside the viewport.
- [x] Verify runtime logs after the layout changes and document the result.

## Current Plan — Knock/Checklist Decision Sync
- [x] Make Knock and Checklist use the same latest-decision status logic.
- [x] Fix No Answer so it counts as done immediately on mobile.
- [x] Add a Done decision filter beside the sale-date filter.
- [x] Add a clear-decision action from the property history so a home returns to Todo.
- [x] Persist the selected Knock route so reps with multiple routes stay on the same county/route context.
- [x] Verify the touched flow and document the result.

## Current Plan — Kevin Optimize Keeps Houses
- [x] Fix Optimize so it preserves the already-loaded optimized properties instead of rebuilding from possibly-empty Home territory data.
- [x] Keep saved `property_hashes`, metrics, active route properties, checklist, and map in one order after Optimize.
- [x] Verify Kevin’s selected route still loads all 64 houses; runtime still shows the separate Home render-loop warning to refactor next.

## Previous Plan — Kevin Route Alignment
- [x] Trace Kevin route rendering across map, checklist, knock, and optimize.
- [x] Identify why map first stop can differ from checklist/knock and why optimize can empty homes.
- [x] Patch the stale shared route hydration cache so refreshed saved route orders are not served stale.
- [x] Patch already-hydrated route ordering so map/checklist/optimize receive the same SavedRoute order.
- [x] Verify the selected Kevin route still loads all 64/64 properties; remaining runtime errors are Base44 rate-limit responses, not route-order code errors.

## Previous Plan — Checklist/Knock Route Order Sync
- [x] Document the suspected root cause and planned handling method.
- [x] Stop Knock from locally reordering a saved route after Checklist/Optimize has saved a new order.
- [x] Add route-update synchronization so Knock refetches when the selected SavedRoute changes.
- [x] Make Knock property hydration react to route order changes, not just route length.
- [x] Add Checklist-side latest SavedRoute order sync so it does not depend on stale Home activeRoute state.
- [x] Verify both sides preserve the same route order source of truth.
- [ ] Separately refactor the oversized Home page before patching the unrelated Home render-loop warning.

## Review
Canvas/Precision mode buttons were moved into the existing top toolbar on mobile and desktop, the old second-row pill under Routes/Builder was removed, and runtime logs showed no new frontend errors after the change.

Canvas Builder now uses a dedicated Canvas-only panel: draw/redraw territory, optional session name, rep count, auto-created numbered zones, per-zone rep assignment, one-tap auto-assign, Save Territory, and Deploy. Precision-only controls are no longer shown in Canvas Mode; Precision keeps the existing sold/data/filter/route builder. Runtime logs after the change showed no new frontend import/build errors. Saved territory loading is handled through persisted polygon state because Home has exceeded the safe edit limit and should be split before adding more listeners.

Canvas/Precision split is now visible in the map toolbar, Canvas opens the existing route builder without requiring a paid data pull, Precision still routes users through area preview/paid pull, Canvas routes are visibly named as Canvas routes, Billing now explains Canvas per-rep pricing and Precision property-credit usage with a remaining-property counter, and Knock/Checklist sync keeps subscriptions/focus refresh without aggressive polling. Backend verification confirmed Canvas route naming in `generateRoutesBackend`; runtime review showed no new frontend compile errors, the detected 429 risk from polling was removed, and the actual `components/billing/PricingModeCard.jsx` file was created so Billing can resolve the component during build.

Freehand drawing now stays active after drawing because stale localStorage cleanup only clears actual restored stale polygons, not fresh in-memory drawings. Sandbox Preview is clarified as validation-only and does not populate properties; after approval, a new Start Paid Pull button creates a real BatchData FetchJob and starts polling. Backend verification passed for `previewBatchDataArea` and `startBatchDataPull` dry-run without spending paid credits.

Previous areas now only persist after a successful sandbox preview/query, old unqueried local history is filtered out, selecting prior queried areas still works, and each previous area now has its own red trash button for deletion. Verification caught and fixed one JSX typo; remaining runtime logs show unrelated Base44 rate-limit noise from route hydration, not this map-history change.

Freehand BatchData sandbox preview is wired: Builder draw now uses freehand drawing, the area toolbar accepts requested property count, free accounts are capped at 50, paid/admin at 1000, oversized areas are rejected server-side, paid pulls remain disabled, and sandbox probe returned 3 records with no app data changes. Backend verification passed for free cap, paid cap, continental-US rejection, sandbox key probe, and Kevin/Reif protected route audit.

BatchData migration continued safely: added a no-cost area/cost preview, migration audit, sandbox BatchData shape probe, BatchData Neon columns/indexes, and a guarded BatchData Precision processor branch. Verified `setupNeonPropertyTables`, `validateBatchDataShape`, `processFetchChunk` idle mode, and Kevin/Reif Environmental audit; Upper/Middle/Lower Mount P remain protected under `kevin@reifenvironmental.com`, and no destructive purge/cutover has run.

Builder drawing now keeps only one active territory shape at a time, hides previous territory history while drawing, and squares now use true 40/300 square-mile side lengths instead of the broken sizing.

Dismiss now remembers the specific incomplete import job, so that recovery popup will stay hidden after you dismiss it while Retry still works normally.

The territory drawing prompt is now a smaller top-left horizontal bar with compact controls, so it covers much less of the 300 sq mile circle while keeping the same actions available.

The Rep map close button now responds immediately on press, stops the tap from reaching the map underneath, and has a slightly larger mobile tap target for smoother closing after the map loads.

Knock tab visuals are now mostly black: the FirstKnock header uses a black background with no visible divider on RepHome, and the RepHome shell, filter bar, and list area now use black backgrounds to remove the mismatched dark hues.

The Route/Knock handoff now saves the active route from the map toolbar and RepHome rejects stale selected route IDs that do not belong to the current account, so tapping the route tab should no longer appear to switch/log out of the email. The remaining Home render-loop warning still needs the already-planned Home page split because direct Home edits are blocked by file size.

About now uses a full-height scroll container with extra bottom padding so content is not cut off behind the app shell, and Contact now shows and links to firstknockhelp@gmail.com.

FirstKnock map zoom now covers more distance per gesture by increasing zoom delta and making wheel/pinch input more responsive while keeping the smoother animation and tile buffering intact.

FirstKnock map zoom now feels smoother by using smaller zoom increments, faster wheel/pinch response, enabled zoom animation, and live tile updates with a larger tile buffer; no route, pin, GPS, or selection logic was changed.

FirstKnock map zoom snap is fixed by raising the RepMapView max zoom and allowing satellite tiles to over-zoom past their native limit, so pinching in after “View on FirstKnock Map” no longer gets forced back out by the tile zoom cap.

Rep Performance graph is now mobile-safe: the chart card clips overflow, uses tighter margins and fixed axis widths, shortens date labels, formats Conv % cleanly, and keeps lines readable without changing the underlying metrics.

Mobile ROUTES/BUILDER toggle is slightly larger with improved touch padding and a max-width guard so it stays centered without overlapping side icons.

Builder tap-to-select now preserves the current zoom: area confirmation activates the map-fit suppression guard before saving state, pans to the selected area center at the existing zoom, and a shared Leaflet fitBounds guard ignores any programmatic fit attempt during that tap-select window.

Builder custom-area UI is fixed for mobile: the active area bar wraps within the viewport, pull/fill actions remain tappable, the helper box no longer clips offscreen, and returning to Builder with an existing area points users to the active bar instead of forcing a redraw/tap-to-confirm flow.

Route banner close control now shows “X CLOSE” on mobile and has a larger touch target so users can clearly exit the active route view.

Optimize button zoom-out fix is localized: mobile/tablet pointer events now hard-stop before reaching the Leaflet map, the Optimize button is easier to tap, and the shared map-fit controller ignores fit requests briefly while route optimization starts so optimization cannot trigger a continental zoom-out. Runtime review still shows unrelated backend rate-limit/dedup log noise, not a new optimize-button error.

Mobile FirstKnock Map zoom/tap responsiveness was improved by removing the Fragment warning spam, drawing dense vector layers with Leaflet canvas, disabling expensive zoom/fade marker animations, delaying tile updates until zoom settles, increasing pin hit targets to 56px, and making map controls larger/touch-optimized. Runtime review still shows the unrelated Home render-loop warning, but the RepMapView Fragment warning was addressed.

Mobile FirstKnock Map performance was improved by removing permanent labels from every house pin, memoizing the pin layer, using only one tile layer, and adding invisible 48px touch targets around pins while preserving the visible pin size. Runtime review showed existing unrelated backend rate-limit noise, with no new RepMapView-specific error surfaced.

Checklist/Knock route order sync is fixed on both sides: Knock now treats SavedRoute.property_hashes as the source of truth and refetches when the selected saved route changes, while Checklist also refreshes the latest saved order directly so stale Home activeRoute state cannot leave the two views out of sync. I also found an unrelated Home maximum-update-depth warning, but Home is over the safe edit limit and should be split before patching that separately.

Knock and Checklist are now aligned around the same latest-decision status behavior: No Answer remains done, Done views can be filtered by every decision type, history has a Clear action that adds an ELIGIBLE reset entry to move the home back to Todo, and the selected Knock route is persisted so reps stay on the same route/county context.

Map settings are cleaner: Apple/Google navigation selection now lives in the Map tab and is saved/shared through localStorage plus an app event so both Route Checklist and Knock tab navigation buttons use the same preference. The unwanted Auto-build on Generate setting was removed, and changing the Sold Date Window no longer prompts or auto-generates routes. Navigation URLs now open directions to the selected property in the selected provider.

Cancel import is now wired end-to-end: the loading overlay has a Cancel Import button, `cancelFetchJob` marks the user's active job as cancelled and releases locks, polling stops locally, and `processFetchChunk` checks cancellation before additional writes, completions, or self-chaining.

Map/builder mobile fixes are in place: tapping the bottom Map tab now forces plain Routes/analyze mode and closes Builder/Route Command panels, Route Command only auto-opens New Routes while in Builder mode, mobile panel/card overflow is constrained, and mobile X/delete/optimize taps stop pointer bubbling to avoid map zoom side effects.

Route Command mobile optimization is complete: the panel shell uses full viewport containment, the tab bar no longer has fixed mobile widths, Delete All/merge actions stack into a mobile grid, and Queued route cards now wrap status/count/action content within the viewport. Runtime review showed no new Route Command-specific errors in the interaction path.

Merge mode polish is complete: the section arrow is now forced visible on mobile, merge checkboxes are larger/high-contrast, and route cards are slightly shorter across Route Command views. Runtime review showed no new Route Command-specific errors after the polish.