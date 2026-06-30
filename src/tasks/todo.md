## Plan — User-Scoped Callback Appointments
- [x] Make Appointments read the signed-in user's visible callback interaction logs, not only Appointment rows.
- [x] Merge log-derived callback rows into the appointment list when a real Appointment row is missing.
- [x] Deduplicate by callback log id and address/date/route so callbacks do not appear twice after backfill succeeds.
- [x] Make refresh reload both appointments and callback logs.
- [x] Verify the build and document results.

### Review — User-Scoped Callback Appointments
Appointments now displays the user's visible Appointment rows plus any visible Callback interaction logs that do not yet have a real Appointment row. The list dedupes by callback log/address/date/route, defaults to All so past callbacks are not hidden, refresh reloads both appointments and logs, log-only rows are safe to open, and `npm run build` passes.