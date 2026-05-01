# Current Task: Fix Knock tab route visibility

## Plan
- [x] Verify from runtime logs why RepHome says there are no active routes.
- [x] Patch RepHome route matching so the explicitly selected route from Route Command is included.
- [x] Add manager/creator fallback matching for saved routes that do not have manager_id populated.
- [x] Patch the Active Routes tab selection path so it stores the selected route for Knock.
- [x] Add URL-based selected-route handoff from the Knock nav item.

## Review
RepHome was filtering out routes unless they were explicitly assigned to the current auth/team-member ID. I updated it to also include the route selected from Route Command, and to include manager-created routes even when older records are missing `manager_id`. Route Command now stores the selected route for Knock, and the Knock nav passes that route ID in the URL as a backup.