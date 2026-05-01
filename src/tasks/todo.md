# Plan

- [x] Trace how newly generated routes are ordered and named.
- [x] Trace how the Route Command panel displays route names/numbers.
- [x] Trace how the map labels route numbers visually.
- [x] Fix the mismatch with the smallest shared-ordering change.
- [x] Verify route command and map labels now use the same route identity/order.

## Review
The mismatch came from generated routes being sorted/displayed by rank in the Route Command panel and map, while the route object name could still say a stale generic name like `Route 1`. I updated generated-route cards, saved-route cards, active route labels, and map click payloads so generic route names are displayed from the same visible route number used on the map. Example: if the map shows `#2`, the Route Command card and active route banner now display `Route 2` instead of keeping an old generic `Route 1` label.