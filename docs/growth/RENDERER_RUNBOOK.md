# FirstKnock growth-media renderer

## What this closes

The repository has an executable, dependency-free Node/FFmpeg renderer for the first
FirstKnock social batch. It converts audited product images and exact screen-recording
trims into content-addressed Instagram and TikTok videos and emits a bounded
`growth-render-result.v1` manifest. A result becomes importable only after its
publish candidates are immutably hosted and its pack and renderer-environment hashes
are allowlisted server-side.

The current checked-in canonical weekly preflight pack is
`config/growth-media/firstknock-weekly-rights-safe-seed.json`, batch
`firstknock-weekly-rights-safe-v2-2026-07`. It contains:

- ten registered, frame-reviewed, privacy-safe video donors;
- four safe FirstKnock-owned image donors;
- fourteen canonical feature-explainer concepts, exactly two unique concepts per day
  for seven days; and
- twenty-eight publish-candidate renditions: one Instagram and one TikTok version per
  concept.

Its canonical normalized pack SHA-256 is
`00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0`.
The exact final v2 pack was reproducibly rebuilt as a private 28-rendition render on
August 6, 2026. The
unhosted render-result SHA-256 is
`e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff`,
and the renderer-environment SHA-256 is
`89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f`.
All 28 final artifact hashes, H.264 codec checks, baked AAC audio checks, and duration
checks passed. The renditions total 28,241,092 bytes. The v2 sources and final files
contain no map or geography promotional-rights blocker. They remain outside the
repository and are not hosted, imported, publication-approved, scheduled, or
published.

The older `config/growth-media/firstknock-weekly-video-seed.json`, canonical SHA-256
`1323a3d47f2a92299bb76ad4ee5d352b6af6114a6b136833fda268fdf7bf4eca`,
is retired blocked audit history and must never be used operationally. Its older
starter previews also remain fenced from content-engine import.

No output is approved or published by the renderer. Every imported rendition still
requires the four Growth Dashboard review gates and owner approval.

## Requirements

- Node.js 20 or later;
- FFmpeg and FFprobe on `PATH`;
- the private audited source directory containing the weekly pack's sanitized videos
  and image sources; and
- optional bold and regular TrueType fonts through:
  - `FIRSTKNOCK_RENDER_FONT_BOLD`
  - `FIRSTKNOCK_RENDER_FONT_REGULAR`

Windows Arial/Segoe UI and common Linux DejaVu/Liberation fonts are detected
automatically.

The renderer never writes to the private source directory. It resolves only audited
opaque filenames, rejects symlinks, copies each input into a private work directory,
re-verifies the staged bytes, strips source metadata, and never persists an absolute
source path in the result manifest.

## Validate the pack

PowerShell:

```powershell
$env:FIRSTKNOCK_RAW_ASSET_DIR = 'C:\private\FirstKnockAssets'
$env:FIRSTKNOCK_PILOT_SANITIZED_VIDEO_OUTPUT = 'C:\private\firstknock-pilot-sanitized'
$env:FIRSTKNOCK_SUPPLEMENT_SANITIZED_VIDEO_OUTPUT = 'C:\private\firstknock-supplement-sanitized'
$env:FIRSTKNOCK_WEEKLY_RIGHTS_SAFE_VIDEO_OUTPUT = 'C:\private\firstknock-weekly-rights-safe'
$env:FIRSTKNOCK_WEEKLY_SOURCE_DIR = 'C:\private\firstknock-weekly-rights-safe-v2-sources'
npm.cmd run stage:growth-weekly-sources

$env:FIRSTKNOCK_ASSET_DIR = 'C:\private\firstknock-weekly-rights-safe-v2-sources'
npm.cmd run render:growth-pack -- --manifest config\growth-media\firstknock-weekly-rights-safe-seed.json --validate-only
```

The staging command copies only the 14 exact audited bytes into a new empty private
directory and writes a path-free receipt. When passing explicit paths instead of the
environment variables above, invoke the script directly so PowerShell/npm argument
forwarding cannot drop the flags:

```powershell
node scripts/stage-growth-weekly-sources.mjs --raw-source-dir C:\private\FirstKnockAssets --pilot-source-dir C:\private\firstknock-pilot-sanitized --supplement-source-dir C:\private\firstknock-supplement-sanitized --rights-safe-source-dir C:\private\firstknock-weekly-rights-safe --output-dir C:\private\firstknock-weekly-rights-safe-v2-sources
```

Validation fails closed when:

- a source byte changes;
- a local source reference contains a path;
- an artifact has mismatched platform attribution;
- a concept does not contain exactly one Instagram and one TikTok rendition;
- a source exceeds three active renditions;
- a privacy-safe source, rights declaration, exact crop, or exact trim is missing; or
- a redaction-required source is marked as a publish candidate.

## Render local review files

```powershell
$env:FIRSTKNOCK_ASSET_DIR = 'C:\private\firstknock-weekly-rights-safe-v2-sources'
$env:FIRSTKNOCK_RENDER_OUTPUT = 'C:\private\firstknock-weekly-rights-safe-v2-render'
npm.cmd run render:growth-pack -- --manifest config\growth-media\firstknock-weekly-rights-safe-seed.json
```

Useful options:

```text
--manifest <pack.json>
--source-dir <private source directory>
--repo-dir <FirstKnock repository>
--output-dir <private output directory>
--only <artifact-key[,artifact-key...]>
--media-origin <exact public HTTPS origin>
--ffmpeg <binary>
--ffprobe <binary>
--validate-only
```

`--media-origin` is only for a host that serves the renderer's exact
`/sha256/<delivery-basename>` layout. Base44 returns the authoritative hosted URL and
may prepend an opaque filename value, so use the Base44 upload handoff to create a
separate hosted result instead of inventing or predicting that URL.

Because npm reserves `--only`, pass a second option separator when selecting artifacts:

```powershell
npm.cmd run render:growth-pack -- -- --only ig-ce-clean-routes-01
```

The output is:

```text
<output>/
  sha256/
    <full-media-sha256>-<platform-content-id>.mp4
  firstknock-weekly-rights-safe-v2-2026-07.render-result.json
```

Local output is ignored by Git. Keep it private until the final rendition passes visual
review.

## Technical output contract

The conservative shared video profile is:

- exact 1080x1920, 9:16;
- MP4 with H.264 High Profile, 8-bit `yuv420p`;
- constant 30 fps;
- approximately 8 Mbps video with a 10 Mbps max rate;
- AAC-LC, 48 kHz, stereo, 128 kbps;
- SDR/Rec.709 and limited video range;
- fast-start (`moov` before `mdat`);
- 5-60 seconds and less than 250 MiB; and
- no source metadata or third-party watermark.

Filter and encoder threading are pinned to a byte-stable profile. The
`render_input_sha256` binds the normalized recipe to the renderer source, FFmpeg build,
and exact bold and regular font hashes. The result also embeds the normalized pack so
the server can recompute the allowlisted `pack_sha256` and each artifact recipe.

The canonical v2 pack uses `baked_owned_or_licensed` audio generated by the
deterministic, hash-bound `firstknock-procedural-ui-v1` recipe. Each artifact's
`overlay_text` lines appear as progressive callouts during the content window, and the
renderer reserves the final 1.55 seconds for the CTA. Do not attach or replace audio
after rendering and then reuse the old result manifest.

The renderer also supports a general, noncanonical `silent` audio mode. Imported silent
renditions require an explicit owner confirmation before unattended automatic
scheduling.

## First-week bootstrap workflow

Before the first fixed-age production winner exists, the owner can open Content Engine
and choose **Start audited week**. Supply the exact allowlisted
`firstknock-weekly-rights-safe-seed.json`, choose the Phoenix target date, acknowledge
the seven-day cap, and enter the owner authorization note.

The server creates exactly two unique concepts per day from eligible audited donor
recipes, with one Instagram and one TikTok rendition for each concept. It does not call
an LLM or create synthetic plan, metric, review, or performance evidence. Each daily
pack is an exact source-and-artifact subset of the allowlisted weekly pack; the server
adds only the durable batch policy, date, owner authorization, source reservations, and
hashes. Repeat the owner action once per intended production day, up to seven active
bootstrap batches. The dashboard defaults the next dialog to the day after the latest
bootstrap batch.

After the full weekly result has explicit hosting authorization and exact remote-byte
verification, derive a daily import result from its downloaded bootstrap pack:

```powershell
npm.cmd run slice:growth-render-result -- `
  --source-result C:\private\firstknock-weekly-rights-safe-v2-render\firstknock-weekly-rights-safe-v2-2026-07.hosted-render-result.json `
  --batch-pack C:\private\firstknock-bootstrap-day-1-render-pack.json `
  --output C:\private\firstknock-bootstrap-day-1-hosted-result.json
```

The slicer accepts only two concepts, four paired artifacts, and exact source/artifact
objects already present in the full result's canonical pack. It preserves the existing
media descriptors and URLs, changes only the result inventory plus daily pack SHA-256,
is idempotent on exact output, and refuses to overwrite a different file. No network
request or upload occurs.

Download, inspect, authorize, render, host, import, review, approve, and activate each
bootstrap pack using the same trust gates below. When using the exact-slice handoff, the
weekly render and hosting steps happen once; each daily result still needs exact-pack
authorization, import, rendition inspection, review, approval, and activation.
Bootstrap authorization is not hosting authorization, content approval, scheduling, or
publication. After fixed-age results mature, stop using bootstrap and select a current
Repeat or Iterate parent for `build_next_batch`.

## Measured daily batch workflow

After a D1, D3, D7, or D30 item has a current Repeat or Iterate decision, Growth
Dashboard's active feature-explainer profile compiles exactly two unique concepts per
day, each with paired Instagram and TikTok renditions:

1. Open **Measured next batch** in the Content Engine.
2. Select the reviewed parent and Phoenix target date.
3. Choose the exact trusted starter `growth-render-result.v1` file; the dashboard uses
   its embedded normalized `pack`. A standalone `growth-render-pack.v1` is also
   accepted.
4. Build the batch. The server rechecks the fixed-age evidence and donor source hashes,
   binds the sanitized source summaries, reserves distinct source hashes for seven
   days, reserves generated hooks for 28 days, and stores the canonical generated
   pack. Generated titles, hooks, overlays, shot lists, captions, and CTA labels fail
   closed on explicit URLs, `www`, bare domains or domain paths, social handles, email
   addresses, and phone numbers.
5. Download the generated pack JSON. Save it outside the repository or in ignored
   render output.
6. Inspect the hooks, captions, disclosure, source choices, crop/trim recipes, and
   platform attribution. The owner may then authorize that exact pack SHA-256 for
   render-result import.
7. Render it with the same private source package and deterministic renderer:

   ```powershell
   npm.cmd run render:growth-pack -- --manifest C:\private\firstknock-next-batch.json --source-dir C:\private\firstknock-weekly-rights-safe-v2-sources --output-dir C:\private\firstknock-next-output
   ```

8. Inspect every local video, stage only the approved candidates at the immutable media
   origin, rerender the manifest with `--media-origin`, and run the origin verifier.
9. Import the resulting `growth-render-result.v1` in Growth Dashboard.
10. Complete the normal visual inspection and four review gates, approve each exact
    rendition, and only then queue the platform posts. Generated renditions are pinned
    to their batch date and active cadence slot: morning is 9:30 AM and midday is
    1:30 PM America/Phoenix. If a slot is missed, do not move it to a later day; create
    and review a new target-date batch so source cooldown remains truthful.

Batch authorization only permits the exact generated pack to cross the render-import
trust boundary. It does not approve a rendition, schedule a post, or enable the Buffer
kill switch.

After step 4, the parent review is lineage-locked while the batch has an unexpired
`generating` lease or is `ready` or `render_authorized`. If the unused batch should no
longer drive production, revoke it before re-reviewing the parent. If its imported
renditions are approved or queued, revoke those approvals and deliveries in the normal
order first. A batch with a rendition that has durable sent evidence cannot be revoked;
do not rewrite published/sent history to release source or hook capacity. An abandoned
expired generation lease does not permanently block re-review.

Repeat and Iterate remain owner-inspected editorial controls in this version. Before
authorization, compare each generated concept with its donor and verify that the
intended major variable—not several uncontrolled variables—changed. The server does
not claim that free-text Iterate directions are automatically single-variable tests.

The canonical weekly pack's ten approved videos and four safe image-derived sources
support seven complete two-concept days before the seven-day cooldown permits a source
to rotate back in. The feature-explainer compiler accepts both audited source kinds;
image-derived concepts still render as video-format platform renditions and reserve
their exact source hash like a video donor. This source-kind allowance never relaxes
the downstream MP4, codec, visual-review, approval, hosting, or delivery gates.

The active `GrowthContentBatch` is the durable first reservation layer for its selected
source keys and hashes plus generated-hook set. Scheduling uses a second, provisional
layer: the schedule action first persists a fenced `reservation_pending` publish job
with the approved artifact, due time, hook, generated-batch identity, and exact source
key/reference/SHA-256 snapshot. It then re-reads durable batch and publish-job
reservations and promotes the row to `queued` only if the seven-day source and 28-day
hook checks still pass.

The expected Instagram/TikTok pair has one narrow same-day exemption from those
cross-content checks: both renditions must have the same canonical concept ID,
render-pack SHA-256, source reservation tokens, and Phoenix day, and must be opposite
platforms. Do not treat a different pack, changed lineage, different day, same-platform
duplicate, or unrelated concept as a pair.

This profile stays inside the current first-party limits documented by
[Meta's Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api),
[TikTok's media transfer guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide),
and
[Buffer's video troubleshooting guide](https://support.buffer.com/article/935-troubleshooting-video-uploads-in-buffer).

## Immutable hosting and import

Buffer does not accept an uploaded file through its API. It fetches a direct public
media URL later, so the approved bytes must remain available at a stable HTTPS URL.
See [Buffer's media-hosting contract](https://developers.buffer.com/guides/hosting-media.html).

### Prepare the production handoff locally

Before changing any external system, generate one deterministic, non-executable
operator handoff from the exact weekly result:

```powershell
npm.cmd run prepare:growth-activation -- `
  --render-result C:\private\firstknock-weekly-rights-safe-v2-render\firstknock-weekly-rights-safe-v2-2026-07.render-result.json `
  --render-output C:\private\firstknock-weekly-rights-safe-v2-render `
  --hosting-review config\growth-media\firstknock-weekly-hosting-review.json `
  --output C:\private\firstknock-weekly-rights-safe-v2-render\firstknock-weekly-rights-safe-v2-2026-07.production-activation-handoff.json
```

The command reruns the offline production-readiness audit, recomputes the exact weekly
result and all 28 local media hashes, verifies that the hosting review is either the
exact pending review or an exact authorized external review, and writes
`growth-production-activation-handoff.v1`. It refuses unsafe media, an unexpected
repository failure, an invalid authorization, a missing output directory, or a
conflicting output file. An exact rerun is idempotent.

The handoff binds the local paths and reviewed hashes, lists the non-secret runtime
values, names every secret without reading or storing its value, and orders the release,
hosting, Buffer connection, separate platform smoke, scheduler, daily bootstrap,
four-gate review, exact owner approval, activation, and measurement evidence. It is
deliberately not executable and always records `activation_authorized: false`. Creating
it performs no hosting, deployment, account connection, remote verification, scheduling,
or publication. Each external stage still requires its separately named owner
authorization.

Treat the generated handoff as an immutable evidence snapshot. After any repository,
authorization, hosting, deployment, channel, scheduler, review, or activation evidence
changes, rerun the command to a new output filename. Do not edit or overwrite an older
snapshot.

Production sequence:

1. Render without `--media-origin`.
2. Inspect the local videos, captions, safe zones, demo labels, crops, and exact screen
   recording boundaries. Confirm that each progressive callout is readable and that
   the final 1.55-second CTA is fully visible. Any changed source, recipe, environment,
   or artifact bytes require a new review.
3. Treat the 28 weekly `publish_candidate` entries as preflight render instructions,
   not publication authorization. Keep every sanitized donor, raw source, image source,
   and retired v1 `sanitized_preview_only` rendition private. The final August 6 v2
   render proves that all 28 exact files pass artifact-hash, H.264 codec, baked
   `firstknock-procedural-ui-v1` AAC, and duration checks. Owner hosting authorization
   and the four dashboard review gates remain separate requirements.
4. The v2 sources and final files contain no map or geography promotional-rights
   blocker. If a future pack introduces embedded third-party map imagery, document
   promotional-use clearance and verify required attribution in the exact final file
   before allowing its media-rights gate to pass.
5. Create a separate external `growth-media-hosting-authorization.v1` JSON review. It
   must exactly bind the raw render-result file SHA-256, normalized pack SHA-256,
   renderer-environment SHA-256, and the sorted, unique, complete set of every publish
   candidate's artifact key and media SHA-256. For the final v2 evidence, these
   top-level identities are pack SHA-256
   `00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0`,
   raw render-result SHA-256
   `e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff`,
   and renderer-environment SHA-256
   `89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f`.
   The review must set `review_status` to
   `authorized`, `hosting_authorized` to `true`, identify the reviewer and UTC review
   time, and have no unresolved blockers. The checked-in
   [`firstknock-weekly-hosting-review.json`](../../config/growth-media/firstknock-weekly-hosting-review.json)
   exactly binds the v2 batch, unhosted result, pack, renderer environment, and all 28
   artifact/media hashes. It remains `pending` with `hosting_authorized: false` only
   because `owner_hosting_authorization_required` is unresolved; it is evidence and a
   schema example, not authorization. An authorized owner must create a separate
   external review for the unchanged result.
6. Configure the exact FirstKnock Base44 namespace. Use the same value locally and in
   the deployed backend:

   ```powershell
   $env:GROWTH_MEDIA_PATH_PREFIX = '/files/public/695eb764b077190880be21de/'
   ```

   `FIRSTKNOCK_BASE44_MEDIA_PATH_PREFIX` is accepted as a local fallback. The prefix
   must remain an app-scoped pathname with leading and trailing slashes.
7. After explicit hosting authorization, upload only the 28 privately rendered and
   visually reviewed candidates. The host command gives each upload the exact basename
   of its emitted `delivery_key` as `File.name`, validates the returned Base44 URL, and
   writes a separate hosted result plus resumable receipt:

   ```powershell
   $env:FIRSTKNOCK_RENDER_RESULT = 'C:\private\firstknock-weekly-rights-safe-v2-render\firstknock-weekly-rights-safe-v2-2026-07.render-result.json'
   $env:FIRSTKNOCK_RENDER_OUTPUT = 'C:\private\firstknock-weekly-rights-safe-v2-render'
   $env:FIRSTKNOCK_HOSTING_REVIEW_FILE = 'C:\private\firstknock-weekly-hosting-review.authorized.json'
   npm.cmd run host:growth-media:base44
   ```

   The outputs are
   `firstknock-weekly-rights-safe-v2-2026-07.hosted-render-result.json` and
   `firstknock-weekly-rights-safe-v2-2026-07.base44-hosting-receipt.json`. The hosted
   result keeps `growth-render-result.v1`, sets the exact Base44 `media_origin`, and
   fills each candidate `media_url` from the actual upload response. Do not modify the
   pack, recipes, hashes, byte sizes, or local review result in place. Hosting a
   candidate is not approval to publish it.

   The launcher verifies the external review before Deno, Base44 authentication, or
   any upload. Missing, pending, false, blocked, mismatched, duplicate, noncanonical,
   or tampered reviews fail closed. The receipt binds the accepted review ID and
   SHA-256, so resumable hosting cannot silently switch authorization.

   The pinned Base44 CLI used by this one hosting command requires Node.js 20.19 or
   later even though the renderer itself supports Node.js 20. Authenticate the Base44
   CLI for app `695eb764b077190880be21de` and ensure Deno is available before running
   the handoff; missing runtime or authentication fails without modifying the unhosted
   result.

   Immediately after Base44 returns a namespace-valid URL, the receipt records
   `uploaded_pending_verification`. If CDN verification is interrupted, rerunning the
   command resumes direct-URL byte verification without uploading the file again. A
   pending URL is never copied into the hosted render result; only a direct `200`,
   `video/mp4`, exact length, and full-SHA match can promote it to hosted.
8. Confirm each returned URL is one direct child of the configured app prefix. Base44
   may prepend an opaque filename value, but the final segment must end with the exact
   `<media-sha256>-<artifact-key>.mp4` basename from `delivery_key`. Reject nested
   paths, a different app prefix, credentials, queries, fragments, percent-encoding,
   and changed or partial delivery basenames.
9. Fetch every hosted publish-candidate URL without redirects and verify direct `200`,
   `video/mp4`, exact byte count, and SHA-256 with the same path prefix:

   ```powershell
   $env:GROWTH_MEDIA_PATH_PREFIX = '/files/public/695eb764b077190880be21de/'
   npm.cmd run verify:growth-media-origin -- --result C:\private\firstknock-weekly-rights-safe-v2-render\firstknock-weekly-rights-safe-v2-2026-07.hosted-render-result.json
   ```

10. Read `pack_sha256` and `renderer.environment_sha256` from that verified result and
   configure:

   ```text
   GROWTH_MEDIA_ORIGIN=https://media.base44.com
   GROWTH_MEDIA_PATH_PREFIX=/files/public/695eb764b077190880be21de/
   GROWTH_RENDER_PACK_SHA256S=<pack_sha256>
   GROWTH_RENDER_ENVIRONMENT_SHA256S=<renderer.environment_sha256>
   ```

   Comma-separated allowlists support a controlled overlap while rolling to a reviewed
   new pack or renderer environment.
11. Open Growth Dashboard, load the audited source inventory, and select **Import render
   result**.
12. Load each hosted rendition in the dashboard and complete privacy, demo-label, claims,
   and media-rights review.
13. Approve the exact revision as the owner.
14. Schedule only after the Buffer channels, worker secret, checked-in five-minute
    scheduler with its one-job-per-invocation bound, worker heartbeat, metric-sync
    smoke, and publishing kill switch have passed staging.

The server imports only `publish_candidate` artifacts. It recomputes and allowlists the
embedded pack and renderer environment, recomputes each render-input hash, and verifies
the result schema, configured media origin and app path prefix, full-SHA delivery key
and hosted-filename suffix, exact creative fields, codec evidence, attribution, QC
flags, byte size, and registered source lineage. `sanitized_preview_only` artifacts are
reported and skipped.

The schedule action copies each source key, opaque reference, and SHA-256 into the
publish job. The backend worker rechecks that immutable snapshot against exactly one
current active privacy-safe source, then repeats the remote byte fetch and rendition
SHA-256 verification immediately before asking Buffer to create a post. A source
safety, reference, or hash change cancels queued delivery or fails closed if provider
work is already live or ambiguous.

On each authenticated scheduler invocation, expired provisional reservations are
handled before normal due jobs. The repair fences the abandoned row, cancels its local
measurement plan, and either finalizes it as `canceled` or leaves
`delivery_reconcile` for retry. The reservation repair itself does not contact Buffer
and does not fetch media. This cleanup occurs only when the operator has deployed and
is invoking the recurring worker.

## Platform and attribution gates

- Both platforms use `https://firstknock.online/start` with separate
  `utm_source` and `utm_content` values.
- `/instagram` remains a backwards-compatible landing path.
- A clickable profile link or controlled comment/DM reply must preserve the exact
  content ID; caption URLs alone are not dependable attribution surfaces.
- [Buffer's current TikTok guidance](https://support.buffer.com/article/559-using-tiktok-with-buffer)
  limits each post to 2,200 characters and no more than five hashtags. The engine
  excludes the raw tracked URL from TikTok provider text, keeps it on the artifact for
  the controlled profile link, and records the measurement CTA as `bio`.
- Instagram and TikTok need separate Buffer channel smoke posts.
- Buffer's current API supports TikTok posts, but its channel documentation warns that
  some TikTok publishing paths use notification publishing. The worker therefore
  requires Buffer to echo `schedulingType=automatic` for a production post; otherwise
  the job stops for review. TikTok automation remains gated on a credentialed staging
  post against the real connected account.
- Trending music, stickers, polls, and other native features require notification/manual
  finishing rather than unattended publishing.

## Current boundary

This renderer is executable locally or on an external worker. The repository does not
yet provision:

- private source-object storage;
- a durable remote render-job lease/callback service;
- deployed Base44 media/backend configuration;
- Buffer credentials or channel IDs; or
- configured production scheduler secrets.

The repository now contains the Base44 hosting bridge, immutable namespace validation,
five-minute GitHub Actions worker trigger bounded to one job per invocation, and
cumulative Buffer D1/D3/D7/D30 metric sync. They remain inactive until deployment and
secrets are configured. Those are deployment and credential steps, not reasons to
bypass review or expose the raw source package. Rendering, final visual review,
credential configuration, worker deployment, default-branch scheduler activation,
Instagram/TikTok smoke posts, and enabling delivery remain operator responsibilities;
the checked-in code does not publish social posts on its own.
