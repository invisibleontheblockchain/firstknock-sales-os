# FirstKnock video capture checklist

## Weekly source target

Two feature-explainer concepts per day with a seven-day source cooldown requires 14
distinct source hashes. The canonical weekly preflight seed is
`config/growth-media/firstknock-weekly-rights-safe-seed.json`, batch
`firstknock-weekly-rights-safe-v2-2026-07`. It combines ten approved video donors
with four safe FirstKnock-owned image donors and defines 14 concepts and 28 paired
Instagram/TikTok artifacts.

The `feature_explainer_video_v1` compiler treats those 14 exact source hashes as one
cooldown pool. An image donor is accepted only because the renderer turns it into a
video-format rendition; the final platform artifact must still satisfy every MP4,
review, approval, immutable-hosting, and delivery check.

The canonical pack SHA-256 is
`00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0`.
Canonical v2 uses baked FirstKnock-owned procedural UI audio
(`firstknock-procedural-ui-v1`), platform-distinct hooks and captions, progressive
context lines, and an end-only CTA positioned inside the vertical safe zone.

The completed canonical-v2 private render produced and hash-bound all 28/28
publish-candidate renditions. Its final local immutable render-result SHA-256 is
`e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff`,
and its final renderer-environment SHA-256 is
`89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f`.
Those values and the 28 artifact hashes are the canonical-v2 local render evidence.
The v2 source inventory has no unresolved map or geography promotional-rights blocker.
Hosting remains pending and unauthorized; the outputs remain outside the repository
and are not hosted, imported, approved for publication, scheduled, or published.
`publish_candidate` means that a rendition is eligible for private rendering; it is not
permission to upload or post it.

The audited first week uses this priority when no earlier reservation consumes a donor:

1. Rerun follow-ups + Generation settings
2. Knock outcome controls + Add Details
3. Route Command + Merge routes
4. One-day analytics + Manager funnel
5. Bulk Re-Knock + Manager comparison
6. Route start/finish + Refresh area
7. Property styling + Accidental-sale correction

This order leads with the clearest route, knock, follow-up, and manager-value stories
before settings and edge-case demonstrations.

The older `config/growth-media/firstknock-weekly-video-seed.json`, canonical SHA-256
`1323a3d47f2a92299bb76ad4ee5d352b6af6114a6b136833fda268fdf7bf4eca`,
is retired blocked audit history and is never an operational input.

Future captures must still exclude or separately clear embedded third-party imagery,
geography, and attribution requirements. That capture rule is not an unresolved
rights blocker for the canonical v2 batch.

Use the following synthetic-capture backlog to replace motion-image donors with
fresh feature walkthroughs over time:

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
- Remove copyrighted music. Silent raw capture is acceptable because canonical v2
  replaces source audio with the owned `firstknock-procedural-ui-v1` track during
  rendering. Narration or music requires a separately owned/licensed, hash-bound recipe.
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
- Capture enough clean action for three progressive context beats; do not depend on one
  static burned-in explanation.
- Reserve the lower safe-zone composition for the final CTA. The CTA is rendered only
  during the final 1.55 seconds and must remain clear of app controls and platform UI.
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
- for Base44 hosting, a separate external
  `growth-media-hosting-authorization.v1` review that exactly binds the render-result
  file, pack, renderer environment, and every publish-candidate artifact/media SHA;
  sets `hosting_authorized` to `true`; and has no unresolved blockers;
- one evidence-bounded feature summary for hooks, narration, and captions; and
- a disclosure such as `Product demo — no customer result or performance promise.`

Instagram and TikTok versions may share the same sanitized source. They must retain
their own platform content IDs and tracked CTA URLs, and canonical v2 requires distinct
platform hooks and captions rather than a label-only variant. TikTok's final Buffer
description must remain within 2,200 characters and use no more than five hashtags
under [Buffer's current TikTok contract](https://support.buffer.com/article/559-using-tiktok-with-buffer).
Its tracked URL is a controlled profile-link target, not raw caption text.

Use `ig-bio` and `tt-bio` for permanent profile links. A post-specific content ID is
conversion evidence only when a clickable Story, DM/comment handoff, or other controlled
surface preserves that ID. The optional `/start` demo question records a separate
visitor-reported assist and never rewrites the generic profile-link touch.

The checked-in
[`firstknock-weekly-hosting-review.json`](../../config/growth-media/firstknock-weekly-hosting-review.json)
exactly binds the v2 batch, pack, final render result, renderer environment, and all
28/28 publish-candidate artifact hashes. It remains `pending` with
`hosting_authorized: false` until the owner resolves
`owner_hosting_authorization_required`. The host command rejects an absent, false,
mismatched, duplicate, or tampered external review before Base44 authentication or
upload. A valid review authorizes immutable hosting only, never publication.
