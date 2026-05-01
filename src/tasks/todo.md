# Current Task: Fix area display and fetch job recovery

## Plan
- [x] Inspect runtime logs for pull/session/job-loss symptoms.
- [x] Locate where the data builder computes/displays square mileage and what geometry is submitted.
- [x] Fix the displayed area to be computed from the current polygon geometry, not stale/default radius state.
- [x] Update pull controls to display/enforce the actual selected polygon area after reload.
- [x] Verify fetch jobs are persisted immediately by the backend when a pull starts.
- [x] Ensure failed-job retry resumes the saved job without incrementing pull count.
- [x] Add reload/re-login recovery UI for incomplete fetch jobs with rejoin/retry actions.
- [x] Verify the fix with logs/code path review and document the result.

## Review
Runtime logs confirmed the backend submitted the selected polygon as ~301 sq mi while the UI label had reset to 5 sq mi. I added shared polygon-area calculation and changed the map label, pull button, large-pull warning, and free/pro enforcement to use the actual polygon geometry. Fetch jobs were already created in the FetchJob table before processing starts; I verified the current job record exists and completed. I added reload/re-login recovery for running/pending jobs plus a failed-job retry banner, and updated backend retry handling so resuming a failed job does not increment pull count or start a fresh full pull.