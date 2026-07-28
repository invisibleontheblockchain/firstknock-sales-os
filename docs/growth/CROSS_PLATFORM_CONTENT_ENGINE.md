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
initial sanitized candidates. Treat analytics values as demo data unless the underlying
customer result and permission are verified.

## Editorial system

### Daily slots

| Slot | Default format | Job |
|---|---|---|
| Morning | Graphic, carousel, or TikTok photo mode | Name one costly operating problem |
| Midday | 10-20 second Reel/TikTok | Show one product behavior solving that problem |
| Evening, optional | Founder clip, FAQ, comment reply, or proof | Answer an objection or report a learning |

Default Arizona publishing windows are 08:30, 12:30, and 17:30. These are starting
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
Instagram:
/start?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-20260803-01

TikTok:
/start?utm_source=tiktok&utm_medium=organic_social&utm_campaign=1000-users&utm_content=tt-20260803-01
```

Do not assign the same platform content ID to both posts. FirstKnock should compare
concept performance across platforms while preserving platform-specific reach,
conversion, and retained-user evidence. Add the neutral `/start` landing route before
TikTok launch; do not send TikTok traffic to the current Instagram-named landing path.

## Publishing architecture

### Recommended delivery layer: Buffer

Use FirstKnock for generation, review, attribution, and learning. Use Buffer for delivery
to the connected Instagram and TikTok accounts.

This avoids two bad foundations:

- browser automation or credential scraping; and
- a private one-brand TikTok Direct Post client that cannot satisfy TikTok's intended-use
  audit policy.

Buffer's current public API supports Instagram and TikTok channels, automatic or
approval-based scheduling, images and videos, exact due times, post status, and metrics.
It requires media to remain available at a stable public HTTPS URL until publishing.

Only approved, sanitized **renditions** may be placed at that public delivery URL. Raw
source assets stay private. Do not use short-lived signed URLs for scheduled Buffer media.

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
  provider + channel + account + platform_content_id + artifact_sha256
```

The worker:

1. leases a bounded batch of due jobs;
2. verifies approval, hash, media metadata, and stable delivery URL;
3. creates or reconciles the provider post;
4. stores the provider post ID and scheduled time;
5. polls or receives status until sent or terminally failed;
6. retries retryable failures with bounded backoff; and
7. never creates a second provider post after an ambiguous response without first
   reconciling.

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
- provider post ID, provider status, and public post URL; and
- sent, failed, or canceled timestamps.

All three entities remain service-role-only. Owner/admin functions return aggregate or
sanitized data and never expose provider tokens or raw private-media URLs.

## Rendering boundary

Base44 can generate structured copy and images, but it is not the right place to run a
long FFmpeg render inside an HTTP request. Use:

1. a short Base44 generation function for a schema-validated creative brief;
2. a durable render job;
3. an external video worker or template renderer;
4. a signed callback or bounded poller;
5. private source storage; and
6. a separate stable delivery copy only after approval.

The initial video template should:

- export 1080x1920 H.264 at 30 fps;
- place the 1206x2622 screen capture inside a safe framed layout rather than blindly
  center-cropping it;
- zoom to the one interaction being explained;
- show a 4-7 word hook in the first second;
- include burned-in captions and one CTA;
- use voiceover or properly licensed platform-safe audio; and
- contain no third-party watermark.

Instagram feed graphics should export at 1080x1350. TikTok photo-mode renditions should
export at 1080x1920.

## Rollout

### Phase 1: publish packs

- ingest and hash the 34 source assets;
- classify privacy and duplicates;
- generate scripts, hooks, captions, shot lists, and rendition instructions;
- render the first sanitized batch;
- approve in one daily review; and
- export or manually schedule while validating quality.

Exit gate: ten approved posts with no privacy, claim, attribution, or media-spec failure.

### Phase 2: scheduled delivery

- connect Instagram and TikTok to Buffer;
- store the Buffer API key only as a server-side secret;
- configure the two channel IDs;
- create the durable publishing outbox and worker;
- start in Buffer/FirstKnock approval mode;
- reconcile provider status and public links; and
- preserve manual cancellation before send.

Exit gate: twenty consecutive scheduled posts delivered or safely failed without a
duplicate, wrong account, wrong time, or unreviewed publish.

### Phase 3: learning loop

- import platform reach and engagement at fixed ages;
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
- Instagram and TikTok Buffer channel IDs;
- stable public delivery host for approved renditions;
- default Arizona posting windows;
- owner/admin approval policy; and
- a decision on voice: founder-recorded, synthetic voice with disclosure, or text/music
  only.

Never paste API keys into source files, a content plan, a browser field, or chat history.
