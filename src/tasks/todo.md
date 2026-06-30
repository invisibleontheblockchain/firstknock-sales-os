## Plan — Callback Homes Missing From Appointments
- [x] Merge callback homes from Knock interaction logs into the Appointments list when an Appointment record is missing.
- [x] Deduplicate log-derived callbacks against real Appointment records by address/date/route.
- [x] Keep normal Appointment cards and filters working, including unscheduled/past/upcoming callback homes.
- [x] Verify with a production build and document the result.

### Review — Callback Homes Missing From Appointments
Appointments now backfills missing callback appointments from Knock callback logs, dedupes against existing appointments, and keeps the normal appointment filters/cards intact. Production build passes.