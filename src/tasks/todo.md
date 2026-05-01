# Current Task: Map route display and settings cleanup

## Plan
- [x] Disable previous-area highlighting/selection on the Routes tab while keeping history visible.
- [x] Make generated/saved route map colors default to a rotating palette instead of one gold color.
- [x] Slightly reduce the default map pin size.
- [x] Clean up the settings panel labels/organization without changing business logic.
- [x] Document verification results.

## Review
Previous drawn areas remain visible on Routes but are no longer interactive or highlightable unless Builder mode is active. Route map rendering now uses a rotating default palette for routes without saved display colors, so generated/saved route groups are individually colored by default. Default dot size was reduced from 5 to 4, and the settings panel labels were simplified around Map/Data/Prefs, overlays, property dots, and route paths. I avoided pushing route-color persistence into `pages/Home` because that file is over the edit limit; the renderer-level color default is the smaller safe fix for the requested map behavior.