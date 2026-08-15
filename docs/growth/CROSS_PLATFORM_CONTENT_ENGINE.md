# FirstKnock cross-platform content engine

## Outcome

Turn FirstKnock's existing product footage, screenshots, operating lessons, and winning
experiments into **exactly two approved feature-explainer concepts per day**. Each
concept gets a native Instagram and TikTok rendition, so the active operating cadence
is:

- 2 canonical concepts per day;
- 2 scheduled posts per day on Instagram;
- 2 scheduled posts per day on TikTok; and
- 14 measurable concepts, or 28 platform posts, per week.

The engine is a closed learning loop:

```text
Private source asset
  -> privacy and claim review
  -> canonical concept
  -> platform-specific script, caption, and rendition
  -> rendered artifact
  -> human approval
  -> scheduled publisher
  -> platform post status and fixed-age metrics
  -> attributed product outcomes
  -> Repeat / Iterate / Hold
  -> next generated batch
```

Automation must increase output without turning private product data, weak claims, or
duplicate creative into public posts.

For the live `1000-users` campaign, scheduling is server-locked to this cadence: only
an authorized `feature_explainer_video_v1` batch containing its exact two concepts and
four approved, currently schedulable Instagram/TikTok renditions can enter automatic
delivery. Manual and legacy drafts remain useful for drafting and review, but cannot be
scheduled under that production campaign. The dashboard performs a read-only batch
preflight before its sequential four-request activation; this reduces avoidable partial
rollouts, but is not a cross-provider transaction, so a failed activation must be
refreshed and safely resumed for only its unfinished posts.

## Implemented foundation

The repository now includes the first safe operating layer:

- service-only `GrowthSourceAsset`, `GrowthCreativeArtifact`, `GrowthContentBatch`,
  `GrowthPublishJob`, and `GrowthPublishHeartbeat` entities;
- an executable Node/FFmpeg renderer with exact source hashes, deterministic crop/trim
  recipes, 1080x1920 H.264 exports, technical probing, full-SHA output keys, and a
  bounded render-result manifest;
- a Growth Dashboard render-result import that verifies the configured origin, codec
  evidence, attribution, QC flags, and registered source lineage before creating or
  revising a draft;
- an owner/admin content queue that registers only opaque source references and
  sanitized summaries;
- optional schema-validated Instagram and TikTok draft generation behind
  `GROWTH_CONTENT_GENERATION_ENABLED`;
- an evidence-bound daily batch compiler whose active feature-explainer profile emits
  exactly two canonical concepts and accepts only a statically allowlisted
  trusted donor pack, reloads the exact reviewed fixed-age metric, excludes Hold
  decisions, reserves two distinct safe source hashes under a seven-day
  target-date cooldown, rejects aliases of the same bytes, and emits a complete paired
  Instagram/TikTok `growth-render-pack.v1`;
- a durable generation lease and request hash, so an exact retry returns the stored
  canonical pack bytes without another model call while concurrent or changed requests
  fail closed; the request also binds the exact sanitized source summaries sent to the
  model;
- a reviewed-parent lineage lock: a `ready` or `render_authorized` descendant, or one
  with an unexpired `generating` lease, prevents the parent Repeat/Iterate/Hold decision
  from being rewritten; an unused downstream batch must be revoked before re-review;
- generated-public-copy validation that rejects explicit URLs, `www`, bare domains,
  domain paths, social handles, email addresses, and phone numbers before a batch can
  become ready;
- durable 28-day generated-hook reservations, exact Phoenix cadence slots for the two
  daily concepts, and sent-post history that remains effective even if an approval is
  later revoked;
- owner-only authorization of the exact generated pack before its hosted render result
  can use the dynamic import path; imported generated renditions remain unapproved and
  must still pass the normal privacy, demo-label, claims, media-rights, and visual
  inspection gates;
- editable manual drafts when generation is disabled;
- blocking privacy, demo-data, claims, and media-rights review;
- fenced source safety and render-identity changes that cancel dependent queued work
  and refuse a false-success update while provider work is live or ambiguous;
- one exact platform-aware provider-text field: Instagram may include the caption,
  disclosure, CTA, and tracking URL; TikTok may include up to 2,200 characters and no
  more than five hashtags under
  [Buffer's current TikTok contract](https://support.buffer.com/article/559-using-tiktok-with-buffer),
  while the tracked URL stays on the artifact as the controlled profile-link target;
- owner-only approval bound to a canonical SHA-256 of the complete public rendition and
  all four passed review gates;
- scheduling bound to the approved hash, exact Buffer organization/channel, UTC due
  time, immutable media origin, and request hash;
- a durable `reservation_pending` publish-job row created before the final global
  source-cooldown and hook-dedupe checks, so overlapping schedulers cannot both claim
  the same provisional capacity;
- artifact-key compare-and-set scheduling locks plus worker-side canonical-job
  suppression, so duplicate artifact or job rows cannot produce two provider posts;
- owner revocation fenced against those scheduling locks, with approval and lease
  ownership rechecked immediately before provider submission;
- a constant-time secret-authenticated Buffer worker with atomic lease fencing;
- a configuration-bound worker heartbeat, so the dashboard and schedule endpoint only
  report delivery ready after a recent authenticated scheduler run;
- a pre-publish fetch that recomputes SHA-256 from the rendition bytes on the configured
  FirstKnock media origin before Buffer receives the URL;
- an immutable source-lineage snapshot on each publish job, with source key, opaque
  reference, and SHA-256 rechecked against the current active privacy-safe source by
  the worker before provider submission;
- an expired-reservation repair sweep that fences abandoned `reservation_pending` rows,
  cancels their local measurement plans, and never contacts Buffer or fetches media;
- a Buffer-channel identity check that rejects the wrong organization, platform,
  disconnected, locked, or paused queue before `createPost`;
- ambiguous-create reconciliation that never blindly replays `createPost`;
- an Instagram and TikTok measurement-plan bridge that uses each platform's exact
  `platform_content_id` and starts its fixed-age snapshot clock when Buffer reports
  `sent`, with a
  local measurement-only retry state that cannot recreate the provider post or be
  blocked by later source/configuration changes;
- automatic cumulative Buffer snapshots at D1, D3, D7, and D30 with a 24-hour capture
  grace, exact provider-post identity, and explicit observed metric types, so missing
  data cannot be mistaken for zero;
- platform-aware Instagram and TikTok checkpoints that keep reach, views,
  engagement, and downstream first-touch conversion rows separate by platform,
  campaign, and content ID while preserving legacy Instagram records. For a
  Buffer-managed plan, manual entry remains locked until that exact publish job and
  checkpoint age has a durable `review_needed` outcome;
- compare-and-set protection on manual plan seeding and publication, so manual growth
  operations cannot overwrite a concurrent Buffer-owned measurement contract; and
- a disabled-by-default kill switch.

The canonical weekly preflight pack is
`config/growth-media/firstknock-weekly-rights-safe-seed.json`, batch
`firstknock-weekly-rights-safe-v2-2026-07`. It registers 14 audited source hashes:
ten approved privacy-safe videos and four safe FirstKnock-owned images. Eight of the
videos are the reviewed rights-safe replacements; the accepted supplemental
remove-accidental-sale derivative and pilot analytics-date derivative complete the
video inventory. The pack defines 14 feature concepts and 28 publish-candidate
renditions--paired Instagram and TikTok versions of every concept--under canonical
SHA-256
`00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0`.
Canonical v2 also binds the `firstknock-procedural-ui-v1` owned procedural audio
recipe, distinct Instagram and TikTok hooks/captions for every concept, progressive
on-screen context, and a safe-zone CTA that appears only during the final 1.55 seconds.

The completed private canonical-v2 render produced and hash-bound all 28/28
publish-candidate renditions. Its final local immutable `growth-render-result.v1` file
SHA-256 is
`e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff`;
its final renderer-environment SHA-256 is
`89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f`.
Those values and the 28 artifact hashes are the canonical-v2 local render evidence.
The v2 source inventory contains no unresolved map or geography promotional-rights
blocker. Hosting remains pending and unauthorized; no canonical-v2 rendition is
hosted, imported, publication-approved, scheduled, or published.
The neutral `/start` landing path and platform-specific UTM links preserve Instagram
and TikTok identity. The repository includes the guarded publisher workflow and Buffer
metric-sync implementation, but no Buffer credentials, deployed scheduler,
credentialed analytics smoke, or social account is connected by this code change.

The older `config/growth-media/firstknock-weekly-video-seed.json`, canonical SHA-256
`1323a3d47f2a92299bb76ad4ee5d352b6af6114a6b136833fda268fdf7bf4eca`,
is retired blocked audit history. It is never an operational render, hosting, import,
scheduling, or publication input.

The 14 distinct safe sources cover seven complete two-concept days under the seven-day
source cooldown; the four images become video-format motion-image renditions during
rendering. The compiler still reports `insufficient_eligible_donors` instead of
silently reusing a source before its cooldown expires.

When Buffer supplies a sent post's analytics, the worker can capture comparable
cumulative D1, D3, D7, and D30 reach/view snapshots and join them to `/start`
conversions by platform content ID. TikTok creation and analytics still require a
credentialed staging smoke because Buffer's current creation guide and API surface are
not fully consistent. Manual Growth Dashboard entry becomes available only after the
exact Buffer checkpoint is explicitly `review_needed`; collecting, captured, unlinked,
and conflicting provider states remain locked.

## Existing source library

The July 28 source package contains:

| Asset type | Count | Notes |
|---|---:|---|
| Vertical screen recordings | 17 | 1206x2622, 3:31.5 total runtime, effectively silent |
| PNG images | 12 | Product screens, graphics, and proof layouts |
| JPG images | 5 | Product analytics and rep-performance views |
| Total | 34 | 444.3 MB |

The recordings are 4.3 to 38.8 seconds long. Sixteen are HEVC MP4 files and one is an
H.264 MOV. They are useful source material, not publish-ready exports: normalize them to
H.264 at 30 fps, reframe the relevant interaction inside 1080x1920, and add a hook,
captions, and voiceover or licensed music.

One duplicate image pair was identified:

- `660F031A-86CB-4C76-9DDF-C0A2784699F0.PNG`
- `99FEEAF5-577C-4862-91F2-18DA2A3741C8.PNG`

They decode to the same pixels. Keep the smaller `99F...` file as the working source and
retain the other only as recoverable archive material.

### Source pillars

1. **Custom area to route:** define an area, retrieve data, build work, and hand it off.
2. **Route Command and reruns:** filters, callbacks, merges, ownership, and follow-up.
3. **Rep field workflow:** assigned work, property context, outcome entry, and completion.
4. **Manager analytics:** leaderboards, door-to-close rates, coaching, and sales review.
5. **Route rescue:** overlap, unclear ownership, disconnected tools, and before/after.
6. **Build in public:** what FirstKnock is building, what is changing, and the 1,000-user
   operating goal.

### Privacy and claim boundary

Never make the raw source package public. Several screenshots and July 22-23 recordings
contain names, emails, route names, addresses, sales records, or device notifications.
Before a source can enter generation, it needs one of:

- `safe`: verified synthetic or already sanitized;
- `redaction_required`: deterministic masks or replacements are defined and reviewed; or
- `blocked`: not eligible for generation.

`IMG_1525`, `3DFF7ABF-98ED-4FDC-AB6C-F06AE9BD8FF9`, and `IMG_1541` are the strongest
initial sanitized analytics candidates. The claim-free phone crop from
`58DA851F-F7C4-4A55-BB44-947C28BD021F` and the owned public `og.png` route-map crop are
also registered with exact hashes. Treat analytics values as demo data unless the
underlying customer result and permission are verified.

## Editorial system

### Daily slots

| Slot | Default format | Job |
|---|---|---|
| 09:30 Arizona | 10-20 second Reel/TikTok | Show one problem and the visible feature behavior |
| 13:30 Arizona | 10-20 second Reel/TikTok | Explain a second feature and its practical benefit |

The active automated windows are 09:30 and 13:30 Arizona. A founder clip, FAQ, or
comment reply can be tested separately, but it does not replace either of the two
daily feature-explainer slots. Change the automated windows only after comparing
fixed-age reach and retained-user outcomes.

### Strategic first-week ordering

When no earlier reservation consumes a donor, the audited bootstrap uses this exact
conversion-first priority rather than sorting concept IDs alphabetically:

| Day | Morning concept | Midday concept |
|---|---|---|
| 1 | Rerun follow-ups | Generation settings |
| 2 | Knock outcome controls | Add Details |
| 3 | Route Command | Merge routes |
| 4 | One-day analytics | Manager funnel |
| 5 | Bulk Re-Knock | Manager comparison |
| 6 | Route start/finish | Refresh area |
| 7 | Property styling | Accidental-sale correction |

The sequence leads with core route, knock, follow-up, and manager-value stories, then
moves bounded settings and edge-case demonstrations later in the week. Source cooldown
and safety reservations still win: if a higher-priority donor is unavailable, the
server selects the next eligible donor without weakening the seven-day cooldown.

### Generation rules

Every canonical concept contains:

- a shared `concept_id`;
- one audience and one problem;
- one 4-7 word opening hook;
- one product behavior or proof point;
- one CTA;
- one source-asset family;
- one major experimental variable;
- an Instagram content ID and a TikTok content ID;
- platform-native caption and disclosure fields whose factual spine is
  **problem -> visible feature behavior -> practical benefit**; and
- an explicit privacy and claim-review state.

The editorial target is to vary hook, length, framing, CTA, or format without changing
several major variables inside one comparison group. The v1 measured compiler does not
mechanically prove that causal constraint; the owner verifies it before authorization.
The system and operator must also:

1. avoid reusing the same source clip inside seven days;
2. avoid near-duplicate hooks inside the active 28-day window;
3. favor Repeat concepts, allocate controlled slots to Iterations, and exclude Hold
   concepts;
4. cap one source asset at three active renditions before new evidence;
5. keep synthetic/demo claims visibly distinct from verified customer results; and
6. never schedule an artifact that is unapproved, privacy-blocked, or missing a stable
   media URL.

### Audited first-week bootstrap

The first production week cannot honestly depend on a Repeat or Iterate winner because
no fixed-age production result exists yet. The owner-only
`build_audited_bootstrap_batch` action closes that bootstrap gap without fabricating a
plan, metric, review, or customer result:

1. Load the exact allowlisted
   `config/growth-media/firstknock-weekly-rights-safe-seed.json`, batch
   `firstknock-weekly-rights-safe-v2-2026-07`, canonical SHA-256
   `00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0`.
2. In Content Engine, choose **Start audited week**, a Phoenix date, acknowledge the
   bounded policy, and save a 10–500 character owner authorization note.
3. The server chooses exactly two currently eligible donors deterministically. The
   action never calls an LLM and preserves each exact audited source, artifact ID,
   caption, disclosure, tracked CTA, and render recipe as a strict subset of the
   allowlisted weekly pack.
4. Every day is exactly two concepts and four paired Instagram/TikTok artifacts. Safe
   owned video or image donors are accepted, but every platform output remains video.
5. Source hashes remain subject to the seven-day cooldown and hooks to the 28-day
   deduplication window. One Phoenix date can have only one active batch.
6. The same seed policy and SHA-256 can create at most seven non-revoked bootstrap
   batches. After that, use fixed-age results and the normal Repeat/Iterate path.

The stored batch uses `batch_input_mode: audited_seed_bootstrap` and binds the policy,
owner, authorization time and note, exact seed hash, selected donor lineage, target
date, and generated pack with hashes. Removing the seed from the runtime allowlist or
changing a registered source invalidates download, authorization, import, and
scheduling. Bootstrap creation still does not render, host, import, approve, schedule,
or publish anything. Because the daily pack is an exact subset, the full weekly result
can be rendered and hosted once; use `npm run slice:growth-render-result` with the
hosted weekly result and downloaded daily pack to derive each four-artifact import
result without changing or uploading its media bytes again.

### Evidence-bound next batch

`build_next_batch` is intentionally narrower than the free-form draft generator:

1. Select one current `reviewed` Repeat or Iterate item from the fixed-age action queue.
2. Choose a Phoenix target date; the active profile requires exactly two concepts.
3. Supply the exact statically allowlisted starter render pack. A generated or merely
   authorized pack can never become a recursive seed trust root.
4. The server reloads the canonical plan and metric, recomputes the metric fingerprint,
   verifies the 24-hour fixed-age window, and hashes the decision, operator note, and
   review timestamps.
5. It selects distinct publish-candidate donor pairs, verifies their registered source
   references and hashes, and reserves the immutable source hashes against active
   batches and actual sent-post history inside seven days.
6. The model receives only sanitized summaries, existing public creative context, the
   fixed-age social metrics, and the operator interpretation. The server--not the
   model—owns IDs, source lineage, render recipes, disclosure, CTA URLs, platforms, and
   `ai_generated: true`. Public generated fields reject explicit URLs, `www`, bare
   domains and domain paths, social handles, email addresses, phone numbers, digits,
   currency, multipliers, testimonials, guarantees, and common unsupported-result
   language before a pack can become ready.
7. The exact canonical pack is stored in `GrowthContentBatch`. Download and inspect it,
   then the owner may authorize that SHA-256 for rendering/import.
8. Authorization is not content approval and does not publish. After rendering and
   import, every rendition still starts as `draft_ready`, `pending`, and
   `not_approved`.
9. Each imported generated rendition retains its batch key, Phoenix target date, and
   morning or midday slot. Scheduling must use the exact reserved cadence instant;
   the target date cannot drift after source cooldown was calculated.

### Guarded daily generation scheduler

The default-branch `growth-generator.yml` workflow can close the interactive
`build_next_batch` trigger gap without gaining owner authority. At 00:15
America/Phoenix it asks the server to prepare the following Phoenix day's batch. The
server, not the workflow, fixes the production campaign, target date,
`feature_explainer_video_v1` profile, morning/midday slots, and count of exactly two
canonical concepts. The request may contain only the action and the checked-in donor
pack; caller-supplied parents, dates, counts, profiles, or donor selections are rejected.

The scheduler chooses the most recently reviewed, published Repeat or Iterate parent
only after recomputing its `growth-decision-sufficiency.v1` result and exact
`growth-review.v3` identity from the current canonical social checkpoint and frozen v2
conversion evidence. A missing, stale, or unsupported policy on the newest review fails
closed; it never causes silent fallback to an older review. Two different parents with
the same latest review timestamp also fail closed. If a batch already occupies the target
date, its exact reviewed lineage is reused; a stale, revoked, conflicting, malformed, or
exhausted batch blocks replacement. An exact retry returns the stored canonical pack
without another model call. A failed batch receives no more than three machine attempts.

This path stops with one `ready` batch containing two concepts and four paired **video
recipes**. It creates zero MP4 files, zero `GrowthCreativeArtifact` rows, and zero
`GrowthPublishJob` rows. The response exposes a machine-readable
`growth-generation-handoff.v1` with state `unrendered_ready`,
state scope `scheduled_generation_output`,
the exact v3 review schema, supported decision-policy ID/reason codes/evidence hash,
`rendered_media_created_by_invocation: 0`, and the ordered external pipeline gates. It does **not** render,
host, authorize, import, review, approve, schedule, or publish.
`build_audited_bootstrap_batch` remains owner-only and is never selected by the
scheduler.

Enablement is deliberately redundant. Configure all of the following only after the
reviewed-evidence and donor-pack checks are ready:

- Base44: `GROWTH_GENERATION_WORKER_SECRET` with at least 32 characters,
  `GROWTH_SCHEDULED_GENERATION_ENABLED=true`,
  `GROWTH_CONTENT_GENERATION_ENABLED=true`, and the canonical seed SHA in
  `GROWTH_RENDER_PACK_SHA256S`;
- GitHub Actions: `GROWTH_GENERATION_WORKER_URL` set exactly to
  `https://firstknock.online/api/functions/manageGrowthContentEngine`,
  `GROWTH_GENERATION_WORKER_SECRET` set to the same server secret, and
  `GROWTH_SCHEDULED_GENERATION_ENABLED=true`.

Removing either enable flag stops unattended generation. Removing either URL/secret
also leaves the workflow inert. A manual workflow dispatch uses the same authentication,
bounded request, idempotency, and review boundary; it is not an approval bypass.

Repository readiness requires both `growth-publisher.yml` and `growth-generator.yml` to
be tracked. Offline readiness still reports generator default-branch deployment,
Base44 runtime configuration, and both scheduled-generation enable flags as
`not_proven`; only production evidence can clear those gates. The activation handoff
describes this automation as `unrendered_manifest_only`, never as completed video
generation.

The reviewed parent is a lineage root, not mutable prompt text. While its descendant has
an unexpired generation lease or is `ready` or `render_authorized`, another review is
rejected. If that downstream batch will not be used, revoke it before changing the
parent decision. Revoke imported rendition approvals and queued deliveries first when
required. A batch with durable sent evidence cannot be revoked: published/sent
timestamps, source cooldown, and hook history remain immutable operating evidence even
if an approval is later revoked. An expired abandoned generation lease does not
permanently lock the parent.

The server-owned `growth-decision-sufficiency.v1` policy requires a canonical fixed-age
checkpoint with an explicitly observed platform-native `reach` or `views` field. Iterate
is supported by that base social evidence. Repeat requires a positive exact activation,
a positive mature retained-user outcome, or a paid user. A social-only Repeat is allowed
only with a separate nontrivial override note. Hold requires three comparable canonical
fixed-age snapshots and ignores unavailable conversion fields rather than treating
`null` as zero.

The `growth-review.v3` identity binds the social hash, frozen
`growth-conversion-evidence.v2` hash and cutoff, decision and operator note, policy ID,
canonical policy-evidence hash, reason codes, and any permitted social-only override
note/hash. The dashboard sends the checkpoint identity it displayed, but the server
recomputes every policy input and rejects stale or forged values. Client-supplied
conversion totals are never trusted generation evidence.

Repeat/Iterate is also a human-controlled editorial decision in this version. The
compiler gives the decision and free-text major variable to the model, but it does not
mechanically prove that an Iterate draft changed only one creative field. The owner
must compare the downloaded donor and generated pack before authorization; downstream
results should not be described as a clean single-variable experiment unless that
inspection confirms it.

## Platform identity and attribution

One experiment becomes two distribution records:

```text
concept: fk-20260803-route-overlap
instagram: ig-20260803-01
tiktok: tt-20260803-01
comparison group: manager-pain-short-video
```

Tracked URLs preserve the shared concept while keeping platform acquisition distinct:

```text
Legacy Instagram links remain supported:
/instagram?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-20260803-01

Content-engine cross-platform links:
Instagram:
/start?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-20260803-01

TikTok:
/start?utm_source=tiktok&utm_medium=organic_social&utm_campaign=1000-users&utm_content=tt-20260803-01

Persistent profile links:
Instagram:
/start?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-bio

TikTok:
/start?utm_source=tiktok&utm_medium=organic_social&utm_campaign=1000-users&utm_content=tt-bio
```

Do not assign the same platform content ID to both posts. The implemented engine creates
or updates the matching platform-aware `GrowthContentPlan` and records `published_at`
from Buffer's sent state. Instagram preserves its tracked URL in the approved provider
text. TikTok preserves the URL on the artifact for the controlled profile link, records
the measurement CTA channel as `bio`, and fails closed if the final provider description
exceeds 2,200 characters. Under
[Buffer's current TikTok guidance](https://support.buffer.com/article/559-using-tiktok-with-buffer),
the description may contain no more than five hashtags.

Instagram caption URLs are not a dependable clickable-link surface for every account
or viewer. The URL is useful as exact creative evidence, but it must not be treated as
reliable per-post conversion attribution without a verified clickable distribution
path (for example, a controlled profile-link or comment/DM workflow) that preserves
`utm_content`.

A persistent `ig-bio` or `tt-bio` link is platform-level evidence and is never
distributed across recent posts. On a generic profile-link visit, `/start` may offer the
visitor an optional one-tap “Which demo brought you here?” question. The choices come
only from recent jobs with matching Buffer `sent` state, a provider post ID, and
identical provider/measurement publication clocks. The selection is stored as
`visitor_self_report` beside the raw generic touch; it never replaces `ig-bio` or
`tt-bio`. The dashboard and CSV show these answers as visitor-reported assists, separate
from declared content-link landings, signups, activation, and paid conversions.

Do not use visitor-reported assists, generic bio conversions, referrer-only traffic, or
time-based guesses as Repeat/Iterate/Hold conversion evidence. A visitor who skips the
question remains platform-level. A delayed, incomplete, duplicate, scheduled, failed,
or cross-platform Buffer job is never exposed as a choice. A bare `/start` view is built
from the current URL/referrer rather than inheriting an unrelated stored content touch.

Every review freezes `growth-conversion-evidence.v2`. A verified declared content link
may freeze exact bounded downstream counters and retention. A post without that link
freezes `conversion_conclusion: inconclusive_no_declared_link`,
`attribution_method: social_evidence_only`, and `null` downstream conversion and
retention values. That social-only record may still support Iterate. Repeat additionally
requires the explicit social-only override bound by `growth-review.v3`; it remains not a
conversion claim. Generation preserves unavailable values as `null`; it never converts
them to zero.

FirstKnock should compare concept performance across platforms while preserving
platform-specific reach, conversion, and retained-user evidence. The neutral `/start`
landing route accepts both platform sources and TikTok referrer inference. Verify
TikTok source reporting and a clickable distribution surface before enabling TikTok
conversion decisions.

## Publishing architecture

### Recommended delivery layer: Buffer

Use FirstKnock for generation, review, attribution, and learning. Use Buffer for delivery
to the connected Instagram and TikTok accounts.

This avoids two bad foundations:

- browser automation or credential scraping; and
- a private one-brand TikTok Direct Post client that cannot satisfy TikTok's intended-use
  audit policy.

The adapter uses Buffer's current channel metadata for Instagram and TikTok,
automatic or notification scheduling, images and videos, exact due times, and post
status. Buffer's public API currently lists both platforms and supports video assets
plus `metadata.thumbnailOffset`; both real channels must still pass staging smoke posts
before the kill switch is enabled. Buffer requires media to remain available at a
stable public HTTPS URL until publishing.

Only locally reviewed, sanitized publish candidates may be staged at that non-indexed
public delivery URL; hosting is not approval. Raw source assets and preview-only
renditions stay private. Do not use short-lived signed URLs for scheduled Buffer media.
Configure an owned immutable origin with `GROWTH_MEDIA_ORIGIN`; the delivery URL must
use that exact origin. Configure its app-scoped pathname namespace separately with
`GROWTH_MEDIA_PATH_PREFIX`, for example
`/files/public/695eb764b077190880be21de/` for FirstKnock. The prefix must be a
canonical absolute pathname with leading and trailing slashes. A rendition URL must be
one direct child of that namespace: no nested path, redirect, credentials, query,
fragment, percent-encoding, or cross-app prefix is accepted.

For Base44-native hosting, upload the file with the exact basename from the renderer's
`delivery_key`: `<64-character-rendition-SHA-256>-<artifact-key>.mp4`. Base44 may
prepend an opaque value to the returned filename, but the final path segment must end
with that complete basename. The origin verifier checks that mapping before it fetches
the URL, then requires a direct `200`, `video/mp4`, exact byte count, and the approved
SHA-256. Storage at that origin remains a security boundary: never replace the object
behind an accepted URL. Because Buffer fetches media after the FirstKnock preflight,
deployment acceptance must also prove an already verified URL continues to return the
same bytes.

The local Base44 handoff is `npm.cmd run host:growth-media:base44`. It reads the
unhosted result from `FIRSTKNOCK_RENDER_RESULT`, uses
`FIRSTKNOCK_RENDER_OUTPUT` for the hosted result and resumable receipt, and requires
an explicit external `FIRSTKNOCK_HOSTING_REVIEW_FILE` plus the same
`GROWTH_MEDIA_PATH_PREFIX` deployed to the Base44 backend. The
`growth-media-hosting-authorization.v1` review must authorize hosting with no blockers
and exactly bind the render-result file SHA-256, pack SHA-256, renderer-environment
SHA-256, and every unique publish-candidate artifact key/media SHA-256 pair. An absent,
pending, false, mismatched, duplicate, or tampered review fails before Deno, Base44
authentication, or upload. The checked-in
[`firstknock-weekly-hosting-review.json`](../../config/growth-media/firstknock-weekly-hosting-review.json)
exactly binds the canonical-v2 batch, pack, final render result, renderer environment,
and all 28/28 publish-candidate artifact hashes. It remains intentionally `pending`
with `hosting_authorized: false`; the owner must resolve
`owner_hosting_authorization_required` before hosting. Run
`verify:growth-media-origin` on an authorized hosted result before dashboard import.
The receipt binds the authorization review ID and SHA-256.
Hosting authorization, hosting, and verification do not approve, schedule, or publish
a rendition.

Useful references:

- [Buffer posts and scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html)
- [Buffer video posts](https://developers.buffer.com/examples/create-video-post.html)
- [Buffer media hosting contract](https://developers.buffer.com/guides/hosting-media.html)
- [Using TikTok with Buffer](https://support.buffer.com/article/559-using-tiktok-with-buffer)
- [TikTok Direct Post requirements](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [TikTok developer sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)
- [TikTok photo publishing](https://developers.tiktok.com/doc/content-posting-api-reference-photo-post/)
- [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)

### Durable publish outbox

Never call the publisher directly from an approval button. Approval creates a durable
publish job:

```text
idempotency key =
  provider + organization + channel + platform + platform_content_id + artifact_sha256
```

Scheduling first persists a provisional `reservation_pending` job containing the exact
approved artifact identity, due time, hook, generated-batch identity, and source
key/reference/SHA-256 snapshot. With that row durable, the endpoint re-reads active
batches, artifacts, and publish jobs and rechecks the seven-day source and 28-day hook
reservations before promoting the row to `queued`. A provisional reservation blocks
competing work only while its fenced lease is live.

This is separate from the durable batch reservation: an active `GrowthContentBatch`
retains its selected source keys and hashes plus generated-hook set while it is
`generating` with a live lease, `ready`, or `render_authorized`. Scheduling therefore
cannot race around either an in-progress compiler claim or another scheduler's
provisional claim.

The only paired-distribution exemption is exact and same-day: Instagram and TikTok
renditions may share source and hook capacity when they have the same canonical
`concept_id`, the same render-pack SHA-256, the same source reservation tokens, opposite
platforms, and the same Phoenix day. This permits the intended two-platform rendition
of one concept; it does not exempt unrelated, mutated, cross-day, or same-platform
creative.

The worker:

1. leases a bounded batch of due jobs;
2. verifies approval and rechecks the job's immutable source key/reference/SHA-256
   snapshot against exactly one current active privacy-safe source, then verifies media
   metadata, immutable origin, and fetched rendition bytes;
3. creates or reconciles the provider post and verifies that Buffer returned the exact
   requested publishing mode; production jobs require `automatic`, and a provider
   fallback to `notification` becomes `review_required` rather than a false success;
4. stores the provider post ID, confirmed publishing mode, and scheduled time;
5. polls or receives status until sent or terminally failed;
6. retries retryable failures with bounded backoff;
7. uses `delivery_reconcile` to cancel the linked platform measurement plan before a
   no-provider failure or owner cancellation can become terminal; and
8. never creates a second provider post after an ambiguous response without first
   reconciling.

Before normal delivery work, the authenticated worker sweeps expired provisional
reservations. It first fences the row into `delivery_reconcile`, then cancels the local
platform measurement plan and finalizes the job as `canceled` or leaves a retryable
repair state. That sweep performs no provider request and no remote-media fetch. It
still depends on an operator deploying and invoking the recurring worker. The
repository includes an inert GitHub Actions scheduler, but it runs only from the
default branch and does no work until its production endpoint and worker-secret
secrets are configured.

An owner may cancel a job locally only while it is still `queued` or `retry_wait` and
has no provider post ID. Once a job is processing, ambiguous, or known to Buffer, the
engine refuses to claim that local revocation canceled the provider post. Cancel and
verify it in Buffer first, then use the explicit owner attestation in FirstKnock to
close a `review_required` job. Sent posts cannot use that resolution. This conservative
boundary keeps a live scheduled post from being hidden behind a misleading local
`canceled` state. Canceling also marks the linked measurement plan canceled so it
cannot become the dashboard's next publish action.

Copy the lease, idempotency, retry, and ambiguous-write pattern already used by
`fieldRoutesIntegration`; do not copy older fire-and-forget scheduled functions.

## Data model

Keep `GrowthContentPlan` as the experiment and editorial brief. Add:

### GrowthSourceAsset

- private source reference and SHA-256;
- media type, codec, dimensions, duration, and captured date;
- content pillar and product behavior;
- transcript or visual summary;
- privacy state, redaction recipe, and review evidence; and
- source lineage and duplicate group.

### GrowthCreativeArtifact

- `concept_id`, platform, platform content ID, plan key, and version;
- source-asset IDs and generation recipe;
- hook, script, shot list, caption, CTA, and disclosure;
- rendition URL, SHA-256, MIME type, dimensions, duration, and thumbnail offset;
- lifecycle: `draft`, `rendering`, `review_required`, `approved`, `rejected`,
  `publish_ready`, or `superseded`; and
- reviewer, review time, and immutable reviewed hash.

### GrowthContentBatch

- reviewed parent identity plus exact evidence and review hashes;
- Phoenix target date, the active profile's two slots, and ordered source/donor
  lineage;
- exact sanitized-prompt-source hash plus ordered generated-hook reservations and hash;
- statically trusted seed-pack hash and generation request hash;
- `generating`, `ready`, `render_authorized`, `failed`, `superseded`, `revoked`
  lifecycle with a fenced lease and attempt count;
- bounded canonical render-pack JSON and SHA-256; and
- owner authorization or revocation audit fields with no provider credentials.

### GrowthPublishJob

- artifact key and immutable artifact hash;
- provider, channel, account, and scheduled time;
- immutable source key/reference/SHA-256 lineage, hook, render-pack, and generated-batch
  snapshots used for cooldown and worker preflight;
- idempotency key and request hash;
- provisional `reservation_pending`, queued/delivery states, attempt count, fenced
  lease, retry time, and last safe error;
- a `measurement_retry` state for a sent provider post whose local publication clock
  still needs to be written;
- a `delivery_reconcile` state and terminal target for a no-provider failure or owner
  cancellation whose linked platform plan still needs to be canceled;
- provider post ID, provider status, and public post URL; and
- sent, failed, or canceled timestamps.

### GrowthPublishHeartbeat

- one configuration-bound `buffer-publisher` health record;
- the last successfully completed authenticated worker invocation;
- bounded inspected/processed counts; and
- no API key, worker secret, access token, or provider credential.

All five entities remain service-role-only. Owner/admin functions return aggregate or
sanitized data and never expose provider tokens or raw private-media URLs.

## Rendering boundary

Base44 can generate structured copy and images, but it is not the right place to run a
long FFmpeg render inside an HTTP request. The checked-in renderer and pack now provide
the executable external-worker boundary:

1. a short Base44 generation function for a schema-validated creative brief;
2. a durable render job;
3. an external video worker or template renderer;
4. a bounded `growth-render-result.v1` import today, followed by a signed callback or
   bounded poller when remote render jobs are provisioned;
5. private source storage; and
6. a separate stable delivery copy before review, so the exact immutable bytes can be
   inspected, approved, and later delivered.

The canonical v2 video template:

- exports 1080x1920 H.264 at constant 30 fps with AAC, Rec.709, and fast-start;
- places the 1206x2622 screen capture inside a safe framed layout rather than blindly
  center-cropping it;
- uses an exact crop/trim for the one interaction being explained;
- shows a 4-7 word hook in the first second;
- uses platform-distinct hooks and captions while retaining one shared concept identity;
- reveals the three context lines progressively instead of burning in one static deck;
- places one CTA inside the vertical safe zone and shows it only during the final
  1.55 seconds;
- bakes FirstKnock-owned procedural UI audio using
  `firstknock-procedural-ui-v1`, with a distinct tone recipe for Instagram and TikTok;
- contains no third-party watermark;
- verifies the exact private source SHA before rendering; and
- accepts the canonical weekly mix of ten reviewed video donors and four safe
  FirstKnock-owned image donors. Both source kinds enter the same
  `feature_explainer_video_v1` cooldown pool, but every Instagram and TikTok
  distribution artifact still renders and imports as video. The mix produces 28 paired
  platform candidates; older redaction-bound previews and excluded `IMG_1420.PNG`
  remain fenced from import.

Instagram feed graphics should export at 1080x1350. TikTok photo-mode renditions should
export at 1080x1920.

See [RENDERER_RUNBOOK.md](./RENDERER_RUNBOOK.md) for commands, output layout, immutable
hosting verification, and dashboard import.

## Rollout

### Phase 1: publish packs

- ingest and hash the 34 source assets;
- classify privacy and duplicates;
- generate scripts, hooks, captions, shot lists, and rendition instructions;
- render the first sanitized batch;
- approve in one daily review; and
- export or manually schedule while validating quality.

Exit gate: ten approved posts with no privacy, claim, attribution, or media-spec failure.

Local progress: the canonical v2 weekly preflight pack reproducibly defines 14 concepts
and 28 paired platform candidates, uses strategic first-week ordering, and passes its
pack validation checks. The private render is complete, and its final local immutable
result, renderer environment, and 28/28 artifact hashes are bound in the pending
hosting review. Owner hosting authorization, immutable hosting, dashboard import, and
all four publication review gates remain required before scheduling.

### Phase 2: scheduled delivery

- connect Instagram and TikTok to Buffer;
- store the Buffer API key only as a server-side secret;
- configure the two channel IDs;
- create the durable publishing outbox and worker;
- start in Buffer/FirstKnock approval mode;
- reconcile provider status and public links; and
- preserve compare-and-set local cancellation before provider submission and require
  verified Buffer cancellation afterward.

Exit gate: twenty consecutive scheduled posts delivered or safely failed without a
duplicate, wrong account, wrong time, or unreviewed publish.

### Phase 3: learning loop

- run the implemented Buffer reach/view capture at D1, D3, D7, and D30;
- join both platform IDs to the shared concept;
- keep product conversion and retained-user attribution in FirstKnock;
- keep static-bio conversions in the platform bucket and visitor selections in the
  separate assist columns;
- compare platform, format, hook, CTA, and source family;
- feed only mature fixed-age platform evidence plus controlled content-link conversion
  evidence into Repeat/Iterate/Hold decisions; and
- retain manual metric entry as a repair path.

Weekly, export the CSV and review each concept in this order:

1. confirm both platform deliveries and the required fixed-age checkpoints;
2. compare reach/views within the same platform, format, and comparison group;
3. diagnose the earliest measured funnel leak;
4. read static-bio totals as platform performance and visitor-reported assists only as
   directional creative evidence;
5. mark the outcome inconclusive when the declared metric is missing or the sample is
   too small;
6. Repeat a mature winner, Iterate exactly one named variable, or Hold only after at
   least three comparable mature misses; and
7. authorize the next exact two-concept/four-artifact batch only after the decision and
   source/privacy evidence are reviewed.

### Phase 4: constrained autopilot

After at least fifty consecutive approved deliveries without a privacy, claim, account,
timing, attribution, duplicate, or media-spec failure, allow automatic approval only
when all of these are true:

- the source asset is `safe`, not merely redacted at render time;
- the template and CTA have a previously approved immutable version;
- the generator introduces no new factual or customer-result claim;
- the output passes deterministic duplicate, duration, dimension, caption, disclosure,
  and link checks;
- the source/template combination is still inside its frequency cap; and
- the owner kill switch is off.

Founder clips, customer claims, new source assets, redacted sources, and new templates
always require review. Constrained autopilot is the path to true automatic posting
without allowing a generative model to make every public-brand decision.

## Configuration required before automated publishing

- connected Buffer Instagram channel;
- connected Buffer TikTok channel;
- server-side `BUFFER_API_KEY`;
- `BUFFER_ORGANIZATION_ID`;
- `BUFFER_INSTAGRAM_CHANNEL_ID`;
- `BUFFER_TIKTOK_CHANNEL_ID`;
- `GROWTH_MEDIA_ORIGIN` set to the exact owned immutable HTTPS origin serving locally
  reviewed staging candidates and approved renditions;
- `GROWTH_MEDIA_PATH_PREFIX` set to the canonical app-scoped Base44 pathname prefix,
  including its leading and trailing slash;
- `GROWTH_RENDER_PACK_SHA256S` set to the reviewed render pack hash (or a short,
  controlled comma-separated rollout allowlist);
- `GROWTH_RENDER_ENVIRONMENT_SHA256S` set to the reviewed renderer-environment hash
  (or a short, controlled comma-separated rollout allowlist);
- an independent random `GROWTH_PUBLISH_WORKER_SECRET` with at least 32 characters;
- `GROWTH_PUBLISH_ENABLED=true` only after credentialed staging posts pass;
- `GROWTH_CONTENT_GENERATION_ENABLED=true` when AI draft generation is desired;
- the checked-in GitHub Actions workflow on the default branch with
  `GROWTH_PUBLISH_WORKER_URL` set to the exact production worker URL and
  `GROWTH_PUBLISH_WORKER_SECRET` set to the same independent worker secret;
- a stable public delivery namespace for locally reviewed staging candidates and
  approved renditions;
- write-once/no-overwrite enforcement for full-SHA rendition keys;
- default Arizona posting windows;
- owner-only approval policy; and
- a decision on voice: founder-recorded, synthetic voice with disclosure, or text/music
  only.

The checked-in `.github/workflows/growth-publisher.yml` invokes
`https://firstknock.online/api/functions/processGrowthPublishQueue` every five minutes
with an Authorization bearer header and processes at most one job per invocation. It
is deliberately inert until both repository secrets are present, and scheduled
workflows run only from the default branch. Run it once with an empty queue after
deployment; the configuration-bound heartbeat must remain fresh, and scheduling stays
disabled if that heartbeat is older than fifteen minutes.

After Buffer marks a post sent, the same worker revisits it for cumulative D1, D3, D7,
and D30 analytics. A checkpoint is written only when Buffer reports fresh analytics
inside the 24-hour grace period and at least reach or views is actually observed.
Missing or mismatched evidence retries or moves to review; it never creates a
fabricated zero row. The worker can process one configured platform independently, but
both channel IDs and separate credentialed smoke posts are required before the intended
dual-platform cadence is operational.

Weekly reach pace is calculated only when every published plan-backed checkpoint due in
the 28-day window has canonical evidence and an observed reach field. Until then, the
dashboard reports expected-due, captured, and reach-observed asset counts separately and
labels the summed reach as a lower bound instead of treating missing reach as zero.

Never paste API keys into source files, a content plan, a browser field, or chat history.

Before the first production handoff, run `npm.cmd run prepare:growth-activation` with
the exact unhosted weekly result, render directory, pending or authorized hosting
review, and an explicit local JSON output path. The generated
`growth-production-activation-handoff.v1` manifest binds the reviewed hashes and turns
the remaining release, hosting, runtime, Buffer, scheduler, smoke, daily review, and
activation requirements into ordered evidence gates. It reads or stores no credential
value and performs no external action; the manifest itself grants no authorization.
