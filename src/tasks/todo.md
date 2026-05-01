# Plan

- [x] Inspect current map settings, data status/settings, checklist navigation, and knock tab navigation preference usage.
- [x] Identify why Apple/Google Maps preference is not consistently applied in both checklist and knock flows.
- [x] Remove the unwanted builder auto-build/generate behavior from map/settings controls.
- [x] Clean up data/map settings labels and controls with minimal UI changes.
- [x] Verify runtime logs show no new errors after changes.

## Review
Map settings are cleaner: Apple/Google navigation selection now lives in the Map tab and is saved/shared through localStorage plus an app event so both Route Checklist and Knock tab navigation buttons use the same preference. The unwanted Auto-build on Generate setting was removed, and changing the Sold Date Window no longer prompts or auto-generates routes. Navigation URLs now open directions to the selected property in the selected provider instead of generic search.