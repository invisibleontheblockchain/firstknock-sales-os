# Plan

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

## Current Plan — Checklist/Knock Route Order Sync
- [x] Document the suspected root cause and planned handling method.
- [x] Stop Knock from locally reordering a saved route after Checklist/Optimize has saved a new order.
- [x] Add route-update synchronization so Knock refetches when the selected SavedRoute changes.
- [x] Make route property hydration react to route order changes, not just route length.
- [x] Verify the Knock-side sync code path and document the result.
- [ ] Separately refactor the oversized Home page before patching the unrelated Home render-loop warning.

## Review
Checklist/Knock route order sync is fixed on the Knock side: Knock now treats SavedRoute.property_hashes as the source of truth, refetches when the selected saved route changes, and no longer applies its own time-based reorder that could fight the Checklist/Optimize order. I also found an unrelated Home maximum-update-depth warning, but Home is over the safe edit limit and should be split before patching that separately.

Knock and Checklist are now aligned around the same latest-decision status behavior: No Answer remains done, Done views can be filtered by every decision type, history has a Clear action that adds an ELIGIBLE reset entry to move the home back to Todo, and the selected Knock route is persisted so reps stay on the same route/county context.

Map settings are cleaner: Apple/Google navigation selection now lives in the Map tab and is saved/shared through localStorage plus an app event so both Route Checklist and Knock tab navigation buttons use the same preference. The unwanted Auto-build on Generate setting was removed, and changing the Sold Date Window no longer prompts or auto-generates routes. Navigation URLs now open directions to the selected property in the selected provider.

Cancel import is now wired end-to-end: the loading overlay has a Cancel Import button, `cancelFetchJob` marks the user's active job as cancelled and releases locks, polling stops locally, and `processFetchChunk` checks cancellation before additional writes, completions, or self-chaining.

Map/builder mobile fixes are in place: tapping the bottom Map tab now forces plain Routes/analyze mode and closes Builder/Route Command panels, Route Command only auto-opens New Routes while in Builder mode, mobile panel/card overflow is constrained, and mobile X/delete/optimize taps stop pointer bubbling to avoid map zoom side effects.

Route Command mobile optimization is complete: the panel shell uses full viewport containment, the tab bar no longer has fixed mobile widths, Delete All/merge actions stack into a mobile grid, and Queued route cards now wrap status/count/action content within the viewport. Runtime review showed no new Route Command-specific errors in the interaction path.

Merge mode polish is complete: the section arrow is now forced visible on mobile, merge checkboxes are larger/high-contrast, and route cards are slightly shorter across Route Command views. Runtime review showed no new Route Command-specific errors after the polish.