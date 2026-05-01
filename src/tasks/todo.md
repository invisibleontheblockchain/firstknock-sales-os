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

## Review
Map settings are cleaner: Apple/Google navigation selection now lives in the Map tab and is saved/shared through localStorage plus an app event so both Route Checklist and Knock tab navigation buttons use the same preference. The unwanted Auto-build on Generate setting was removed, and changing the Sold Date Window no longer prompts or auto-generates routes. Navigation URLs now open directions to the selected property in the selected provider instead of generic search.

Cancel import is now wired end-to-end: the loading overlay has a Cancel Import button, `cancelFetchJob` marks the user's active job as cancelled and releases locks, polling stops locally, and `processFetchChunk` checks cancellation before additional writes, completions, or self-chaining.

Map/builder mobile fixes are in place: tapping the bottom Map tab now forces plain Routes/analyze mode and closes Builder/Route Command panels, Route Command only auto-opens New Routes while in Builder mode, mobile panel/card overflow is constrained, and mobile X/delete/optimize taps stop pointer bubbling to avoid map zoom side effects.