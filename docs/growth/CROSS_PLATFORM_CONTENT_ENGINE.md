# FirstKnock cross-platform content engine

## Outcome

Turn FirstKnock's existing product footage, screenshots, operating lessons, and winning
experiments into **two approved canonical concepts per day**, with an optional third
concept when there is enough distinct source material. Each concept gets a native
Instagram and TikTok rendition, so the operating cadence is:

- 2 to 3 canonical concepts per day;
- 2 to 3 scheduled posts per day on Instagram;
- 2 to 3 scheduled posts per day on TikTok; and
- 14 to 21 measurable concepts per week rather than 28 to 42 unrelated experiments.

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

## Implemented foundation

The repository now includes the first safe operating layer:

- service-only `GrowthSourceAsset`, `GrowthCreativeArtifact`, `GrowthPublishJob`, and
  `GrowthPublishHeartbeat` entities;
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
- editable manual drafts when generation is disabled;
- blocking privacy, demo-data, claims, and media-rights review;
- fenced source safety and render-identity changes that cancel dependent queued work
  and refuse a false-success update while provider work is live or ambiguous;
- one exact provider-text field containing the caption, disclosure, CTA, and tracking
  URL;
- owner-only approval bound to a canonical SHA-256 of the complete public rendition and
  all four passed review gates;
- scheduling bound to the approved hash, exact Buffer organization/channel, UTC due
  time, immutable media origin, and request hash;
- artifact-key compare-and-set scheduling locks plus worker-side canonical-job
  suppression, so duplicate artifact or job rows cannot produce two provider posts;
- owner revocation fenced against those scheduling locks, with approval and lease
  ownership rechecked immediately before provider submission;
- a constant-time secret-authenticated Buffer worker with atomic lease fencing;
- a configuration-bound worker heartbeat, so the dashboard and schedule endpoint only
  report delivery ready after a recent authenticated scheduler run;
- a pre-publish fetch that recomputes SHA-256 from the rendition bytes on the configured
  FirstKnock media origin before Buffer receives the URL;
- a Buffer-channel identity check that rejects the wrong organization, platform,
  disconnected, locked, or paused queue before `createPost`;
- ambiguous-create reconciliation that never blindly replays `createPost`;
- an Instagram and TikTok measurement-plan bridge that uses each platform's exact
  `platform_content_id` and starts its fixed-age snapshot clock when Buffer reports
  `sent`, with a
  local measurement-only retry state that cannot recreate the provider post or be
  blocked by later source/configuration changes;
- a 24-hour capture window after each D1, D3, D7, or D30 checkpoint, so late
  cumulative analytics remain descriptive but cannot masquerade as comparable
  fixed-age evidence or drive Repeat/Iterate/Hold;
- platform-aware manual Instagram and TikTok checkpoints that keep reach, views,
  engagement, and downstream first-touch conversion rows separate by platform,
  campaign, and content ID while preserving legacy Instagram records;
- compare-and-set protection on manual plan seeding and publication, so manual growth
  operations cannot overwrite a concurrent Buffer-owned measurement contract; and
- a disabled-by-default kill switch.

The dashboard can load metadata and exact hashes for five audited starter sources. The
local renderer produces ten publish-candidate renditions plus two sanitized video
previews without uploading or copying the source package. The neutral `/start` landing
path and platform-specific UTM links preserve Instagram and TikTok identity. No public
rendition host, Buffer credentials, live scheduler, automated TikTok reach import, or
social account is connected by this code change.

TikTok reach and engagement can be entered manually in Growth Dashboard today and join
to TikTok `/start` conversions by content ID. Automatic provider ingestion remains a
later deployment step.

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
| 09:30 Arizona | Graphic, carousel, or TikTok photo mode | Name one costly operating problem |
| 13:30 Arizona | 10-20 second Reel/TikTok | Show one product behavior solving that problem |
| 18:30 Arizona, optional | Founder clip, FAQ, comment reply, or proof | Answer an objection or report a learning |

Default Arizona publishing windows are 09:30, 13:30, and 18:30. These are starting
hypotheses. Change them only after comparing fixed-age reach and retained-user outcomes.

### Weekly rotation

| Day | Primary pillar |
|---|---|
| Monday | Custom areas and route creation |
| Tuesday | Route Command, filters, and reruns |
| Wednesday | Rep field workflow |
| Thursday | Manager analytics and coaching |
| Friday | Route rescue and operational pain |
| Saturday | Founder/build-in-public |
| Sunday | FAQ, comment response, or weekly roundup |

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
- platform-native caption and disclosure fields; and
- an explicit privacy and claim-review state.

The generator may create hook, length, framing, CTA, and format variants. It must not
change multiple major variables inside one comparison group. It must also:

1. avoid reusing the same source clip inside seven days;
2. avoid near-duplicate hooks inside the active 28-day window;
3. favor Repeat concepts, allocate controlled slots to Iterations, and exclude Hold
   concepts;
4. cap one source asset at three active renditions before new evidence;
5. keep synthetic/demo claims visibly distinct from verified customer results; and
6. never schedule an artifact that is unapproved, privacy-blocked, or missing a stable
   media URL.

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
```

Do not assign the same platform content ID to both posts. The implemented engine creates
or updates the matching platform-aware `GrowthContentPlan`, embeds its tracked URL in
the exact approved provider text as `caption_url`, and records `published_at` from
Buffer's sent state.

Instagram caption URLs are not a dependable clickable-link surface for every account
or viewer. The URL is useful as exact creative evidence, but it must not be treated as
reliable per-post conversion attribution without a verified clickable distribution
path (for example, a controlled profile-link or comment/DM workflow) that preserves
`utm_content`.
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
status. Buffer's general supported-platform guide does not yet list every capability
exposed by the evolving schema, so both real channels must pass staging smoke posts
before the kill switch is enabled. Buffer requires media to remain available at a
stable public HTTPS URL until publishing.

Only locally reviewed, sanitized publish candidates may be staged at that non-indexed
public delivery URL; hosting is not approval. Raw source assets and preview-only
renditions stay private. Do not use short-lived signed URLs for scheduled Buffer media.
Configure an owned immutable origin with `GROWTH_MEDIA_ORIGIN`; the delivery URL must
use that exact origin and include the complete 64-character rendition SHA-256.
Storage at that origin is a security boundary: keys must be content-addressed,
write-once, and reject overwrites for the lifetime of every scheduled post. Immediately
before a create request, the worker downloads the bounded rendition without following
redirects, rejects MIME mismatches, recomputes the full SHA-256 from the bytes, and
fails closed if it differs from approval. Because Buffer fetches media after the
FirstKnock preflight, byte-to-URL integrity depends on that no-overwrite origin contract;
deployment acceptance must include an attempted overwrite that the host rejects.

Useful references:

- [Buffer posts and scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html)
- [Buffer video posts](https://developers.buffer.com/examples/create-video-post.html)
- [Buffer media hosting contract](https://developers.buffer.com/guides/hosting-media.html)
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

The worker:

1. leases a bounded batch of due jobs;
2. verifies approval, exact registered source lineage, media metadata, immutable
   origin, and fetched rendition bytes;
3. creates or reconciles the provider post;
4. stores the provider post ID and scheduled time;
5. polls or receives status until sent or terminally failed;
6. retries retryable failures with bounded backoff;
7. uses `delivery_reconcile` to cancel the linked platform measurement plan before a
   no-provider failure or owner cancellation can become terminal; and
8. never creates a second provider post after an ambiguous response without first
   reconciling.

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

### GrowthPublishJob

- artifact key and immutable artifact hash;
- provider, channel, account, and scheduled time;
- idempotency key and request hash;
- state, attempt count, lease, retry time, and last safe error;
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

All four entities remain service-role-only. Owner/admin functions return aggregate or
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

The initial video template now:

- exports 1080x1920 H.264 at constant 30 fps with AAC, Rec.709, and fast-start;
- places the 1206x2622 screen capture inside a safe framed layout rather than blindly
  center-cropping it;
- uses an exact crop/trim for the one interaction being explained;
- shows a 4-7 word hook in the first second;
- includes burned-in context, demo disclosure, and one CTA;
- emits a silent AAC review track until hash-bound owned/licensed audio is implemented;
- contains no third-party watermark;
- verifies the exact private source SHA before rendering; and
- distinguishes ten importable publish candidates from two redaction-bound previews.

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

Local progress: ten publish-candidate renditions now exist as a reproducible pack and
pass deterministic technical checks. They are not approved posts until they are hosted,
loaded in the dashboard, inspected, and passed through all four review gates.

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

- automate the currently manual platform reach and engagement checkpoints at fixed ages;
- join both platform IDs to the shared concept;
- keep product conversion and retained-user attribution in FirstKnock;
- compare platform, format, hook, CTA, and source family;
- feed only evidence-backed Repeat/Iterate/Hold decisions into the next batch; and
- retain manual metric entry as a repair path.

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
- `GROWTH_RENDER_PACK_SHA256S` set to the reviewed render pack hash (or a short,
  controlled comma-separated rollout allowlist);
- `GROWTH_RENDER_ENVIRONMENT_SHA256S` set to the reviewed renderer-environment hash
  (or a short, controlled comma-separated rollout allowlist);
- an independent random `GROWTH_PUBLISH_WORKER_SECRET` with at least 32 characters;
- `GROWTH_PUBLISH_ENABLED=true` only after credentialed staging posts pass;
- `GROWTH_CONTENT_GENERATION_ENABLED=true` when AI draft generation is desired;
- a stable, non-indexed public delivery host for locally reviewed staging candidates
  and approved renditions;
- write-once/no-overwrite enforcement for full-SHA rendition keys;
- default Arizona posting windows;
- owner-only approval policy; and
- a decision on voice: founder-recorded, synthetic voice with disclosure, or text/music
  only.

Run an external scheduler once per minute against `processGrowthPublishQueue` with the
worker secret in an Authorization bearer header. Keep the worker batch at five or fewer.
Run it once with an empty queue after deployment so the configuration-bound heartbeat
is fresh; scheduling remains disabled if that heartbeat is older than three minutes.
The worker can process one configured platform independently, but both channel IDs are
required before the intended dual-platform cadence is operational.

Never paste API keys into source files, a content plan, a browser field, or chat history.
