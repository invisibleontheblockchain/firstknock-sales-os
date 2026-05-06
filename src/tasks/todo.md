# Plan

## Current Plan — Persist Incomplete Import Dismiss
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