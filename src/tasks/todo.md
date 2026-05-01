# Current Task: Fix build errors from map provider changes

## Plan
- [x] Review lessons and runtime logs before changing code.
- [x] Inspect Kevin's user/team/route records and compare against healthy route records.
- [x] Identify and patch any Kevin route visibility/active/assignment fields that block auto-rendering.
- [x] Audit all map provider URL/deep-link creation paths.
- [x] Implement one shared maps-provider/address-link helper and wire Checklist, Knock, route views, onboarding, and Settings to it.
- [x] Add ingestion diagnostics for per-sub-circle counts, coverage gaps, dedupe impact, result caps, and merge totals.
- [x] Verify Kevin route hydration, provider switching, address URL formatting, and ingestion diagnostics with logs/tests.
- [x] Fix any verification-time issues before marking complete.

## Review
Kevin route hydration now returns all tested migrated hashes for `kevin@reifenvironmental.com`, so saved routes can populate with coordinates on map load instead of only after manual route clicks. Map links now use one shared address formatter/provider helper across Checklist, Knock cards, rep/manager detail sheets, and route export helpers; Settings exposes an immediate Maps Provider switch. Large-area ingestion now logs `GRID_COVERAGE` at job creation and `SUB_CIRCLE_STATS` per processed cell, including raw/mapped counts, polygon/filter/dupe drops, and pagination-cap warnings.