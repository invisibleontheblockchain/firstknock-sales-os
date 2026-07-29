# FirstKnock video capture checklist

## Weekly source target

Two videos per day with a seven-day source cooldown requires 14 distinct, approved
video donors. The audited July folder supplies seven approved donors after exact
trimming, masking, hashing, and visual review; the obstructed refresh-area candidate
is excluded. Capture these seven missing synthetic
walkthroughs before extending the pilot beyond four days:

1. **Merge, split, and assign routes.** Show selecting two demo routes, merging or
   splitting them, and assigning the result to `Demo Rep`.
2. **Run a knock and log an outcome.** Open one fictional stop and select one outcome
   such as No Answer or Callback.
3. **Build the callback or re-knock queue.** Move fictional stops into a follow-up
   route and show the resulting queue.
4. **Add notes, photo proof, and callback time.** Use a blank demo photo or a
   FirstKnock-owned placeholder—never a real home, person, document, or license plate.
5. **Record a sale and review revenue.** Use clearly labeled demo values and show a
   coherent non-empty result without presenting it as a customer result.
6. **Show appointments and team management, or signup/onboarding.** Pick one complete
   workflow and keep the clip focused on that single feature.

Each completed capture becomes one source donor. Do not count alternate edits,
captions, or platform renditions of the same recording as additional donors.

## Before recording

- Use a dedicated synthetic demo account.
- Use only fictional names, route names, addresses, phone numbers, email addresses,
  notes, dates, prices, commissions, property values, and revenue values.
- Prefer obvious labels such as `Demo Rep`, `Demo Route 01`, and `Sample Property`.
  Confirm that no placeholder resolves to a real residence or person.
- Never record a personal or customer Home Base, live GPS position, customer list,
  homeowner name, teammate name, account name, or private quota.
- Clear notifications and recent-app previews. Disable notification banners and
  prevent Control Center, clipboard suggestions, password prompts, autofill contacts,
  carrier/account labels, or profile avatars from entering the recording.
- Remove copyrighted music. Silent source audio is acceptable because narration and
  captions are added during rendering.
- Reset the demo flow before recording. Avoid loading, empty, error, deleted,
  unconfigured-integration, or `0 remaining` states unless that state is the explicit
  subject of the video.
- Record at either 1206×2622 or 1080×1920 in portrait orientation.

## Capture standard

- Record 10–15 seconds.
- Demonstrate exactly one feature and one user action.
- Hold the initial state for roughly half a second, perform the action cleanly, and
  hold the result for roughly one second.
- Keep taps deliberate and avoid scrolling past the feature.
- Keep app text large enough to read after a 1080×1920 export.
- Keep the status bar free of personal information even when the planned render will
  crop it.
- Do not state or display performance, revenue, conversion, time-saving, distance, or
  optimization claims unless the exact claim has separately approved evidence.
- Label fictional metrics as demo data. Never style fabricated values as customer
  proof or a testimonial.

## Frame-by-frame safety review

Review the raw recording locally before it enters any generation or publishing
workflow:

- Inspect the first frame, last frame, and every transition or scroll position.
- Search for names, addresses, coordinates, phone numbers, email addresses, notes,
  photos, property records, map pins, account limits, and notifications.
- Reject and re-record when private data moves, scrolls, or appears behind a modal.
  Do not rely on an approximate blur for moving private data.
- Use a hard trim when the safe action ends before private data appears. The renderer
  must reject every frame at or after that trim boundary.
- Use an opaque, bounded mask for static private text. Record the exact rectangle and
  active time range in raw-source pixel and millisecond coordinates.
- Never upload an unsanitized recording to an external video-generation, captioning,
  transcription, or scheduling service.

## Handoff requirements

A capture is not publishable until the handoff contains:

- the exact raw filename, byte size, duration, dimensions, codec, and SHA-256;
- a unique derived asset key;
- FirstKnock-owned rights confirmation;
- exact trim, crop, and mask instructions;
- a locally rendered sanitized derivative with its own SHA-256;
- frame-review approval for the sanitized derivative;
- one evidence-bounded feature summary for hooks, narration, and captions; and
- a disclosure such as `Product demo — no customer result or performance promise.`

Instagram and TikTok versions may share the same sanitized source. They must retain
their own platform content IDs and tracked CTA URLs.
