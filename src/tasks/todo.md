## Plan — Map Callback + Appointment Card Cleanup
- [x] Make the Home map property detail callback action open the same contact/date-time prompt used in Knock before saving.
- [x] Save callback contact/date-time details from the Home map flow into the interaction log payload.
- [x] Add a delete/remove action for interaction history rows inside property details.
- [x] Simplify appointment cards/details by removing lead score/star/red zero and showing appointment number, address, and route name.
- [x] Verify the app builds and document the result.

### Review — Map Callback + Appointment Card Cleanup
Home map property details now uses the Knock-style callback contact/date-time prompt, property history rows can be removed from the details sheet, and appointment cards/details show appointment number, address, and route name without score/star/zero UI. `npm run build` passes and a code check confirms the lead score/star references are removed from appointment UI.