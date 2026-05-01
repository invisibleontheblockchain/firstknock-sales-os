# Plan

- [x] Find where sale confirmation creates the SOLD history/log.
- [x] Find the sold history UI and whether it has delete/cancel controls.
- [x] Add a minimal cancel/delete sale action that removes the sale log and refreshes route/property state.
- [x] Verify the impacted files and update this review with results.

## Review
Sale confirmation creates a SOLD InteractionLog from `PropertyDetailSheet`, and the history UI showed the log but had no removal control. I added a `Cancel sale` button only on SOLD history entries, wired it to delete that InteractionLog, immediately remove it from the open history sheet, refresh route/log analytics queries, and show a confirmation toast. This puts the property back into route eligibility once the SOLD log is gone.