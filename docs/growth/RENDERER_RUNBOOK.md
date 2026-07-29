# FirstKnock growth-media renderer

## What this closes

The repository has an executable, dependency-free Node/FFmpeg renderer for the first
FirstKnock social batch. It converts audited product images and exact screen-recording
trims into content-addressed Instagram and TikTok videos and emits a bounded
`growth-render-result.v1` manifest. A result becomes importable only after its
publish candidates are immutably hosted and its pack and renderer-environment hashes
are allowlisted server-side.

The checked-in starter pack contains:

- five registered privacy-safe sources plus one redaction-required preview source,
  all with exact SHA-256 values;
- five canonical concepts;
- ten privacy-safe publish-candidate renditions: one Instagram and one TikTok version
  per concept; and
- one additional dynamic concept with two `sanitized_preview_only` renditions.

The preview-only pair proves real screen-recording rendering, but cannot enter the
content engine because its raw source requires an exact privacy trim. Promote a
separately hashed sanitized source before changing those artifacts to
`publish_candidate`.

No output is approved or published by the renderer. Every imported rendition still
requires the four Growth Dashboard review gates and owner approval.

## Requirements

- Node.js 20 or later;
- FFmpeg and FFprobe on `PATH`;
- the private July 28 FirstKnock asset directory; and
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
$env:FIRSTKNOCK_ASSET_DIR = 'C:\path\to\FirstKnockAssets'
npm.cmd run render:growth-pack -- --validate-only
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
$env:FIRSTKNOCK_ASSET_DIR = 'C:\path\to\FirstKnockAssets'
$env:FIRSTKNOCK_RENDER_OUTPUT = 'C:\private\firstknock-render-output'
npm.cmd run render:growth-pack
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

Because npm reserves `--only`, pass a second option separator when selecting artifacts:

```powershell
npm.cmd run render:growth-pack -- -- --only ig-ce-clean-routes-01
```

The output is:

```text
<output>/
  sha256/
    <full-media-sha256>-<platform-content-id>.mp4
  firstknock-safe-starter-2026-07.render-result.json
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

The first automated pack uses a silent AAC track. Add founder voiceover or owned/licensed
audio only through a future hash-bound audio recipe; do not attach untracked music after
rendering and then reuse the old result manifest. Imported silent renditions default to
Buffer notification finishing; automatic silent delivery requires an explicit owner
choice.

## Measured daily batch workflow

After a D1, D3, D7, or D30 item has a current Repeat or Iterate decision, Growth
Dashboard can compile the next two or three paired Instagram/TikTok concepts:

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
   npm.cmd run render:growth-pack -- --manifest C:\private\firstknock-next-batch.json --source-dir C:\private\FirstKnockAssets --output-dir C:\private\firstknock-next-output
   ```

8. Inspect every local video, stage only the approved candidates at the immutable media
   origin, rerender the manifest with `--media-origin`, and run the origin verifier.
9. Import the resulting `growth-render-result.v1` in Growth Dashboard.
10. Complete the normal visual inspection and four review gates, approve each exact
    rendition, and only then queue the platform posts. Generated renditions are pinned
    to their batch date and cadence slot: morning is 9:30 AM, midday is 1:30 PM, and
    evening is 6:30 PM America/Phoenix. If a slot is missed, do not move it to a later
    day; create and review a new target-date batch so source cooldown remains truthful.

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

The current five safe donor sources support roughly two two-concept days before the
seven-day cooldown correctly stops generation. A sustained two-post daily rotation
needs 14 distinct safe sources; three posts daily needs 21.

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

Production sequence:

1. Render without `--media-origin`.
2. Inspect the local videos, captions, safe zones, demo labels, crops, and exact screen
   recording boundaries.
3. Treat the ten visually reviewed `publish_candidate` files as sanitized staging
   candidates. Keep both `sanitized_preview_only` files and every raw source private.
4. Upload only those ten staging candidates to the owned, non-indexed, write-once
   origin using each emitted `delivery_key`. Hosting a candidate is not approval to
   publish it.
5. Confirm the origin rejects overwriting an existing key with different bytes.
6. Re-run the same pack with `--media-origin https://<exact-origin>` to emit identical
   hashes plus canonical URLs.
7. Fetch every publish-candidate URL without redirects and verify `200`, `video/mp4`,
   byte count, and
   SHA-256:

   ```powershell
   npm.cmd run verify:growth-media-origin -- --result C:\private\firstknock-render-output\firstknock-safe-starter-2026-07.render-result.json
   ```

8. Read `pack_sha256` and `renderer.environment_sha256` from that verified result and
   configure:

   ```text
   GROWTH_MEDIA_ORIGIN=https://<exact-origin>
   GROWTH_RENDER_PACK_SHA256S=<pack_sha256>
   GROWTH_RENDER_ENVIRONMENT_SHA256S=<renderer.environment_sha256>
   ```

   Comma-separated allowlists support a controlled overlap while rolling to a reviewed
   new pack or renderer environment.
9. Open Growth Dashboard, load the five audited sources, and select **Import render
   result**.
10. Load each hosted rendition in the dashboard and complete privacy, demo-label, claims,
   and media-rights review.
11. Approve the exact revision as the owner.
12. Schedule only after the Buffer channels, worker secret, once-per-minute scheduler,
    worker heartbeat, and publishing kill switch have passed staging.

The server imports only `publish_candidate` artifacts. It recomputes and allowlists the
embedded pack and renderer environment, recomputes each render-input hash, and verifies
the result schema, configured media origin, full-SHA delivery key and URL, exact creative
fields, codec evidence, attribution, QC flags, byte size, and registered source lineage.
`sanitized_preview_only` artifacts are reported and skipped.

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
- Instagram and TikTok need separate Buffer channel smoke posts.
- Buffer's current TikTok help material and API surface are not perfectly consistent,
  so TikTok video and photo automation remains gated on credentialed staging.
- Trending music, stickers, polls, and other native features require notification/manual
  finishing rather than unattended publishing.

## Current boundary

This renderer is executable locally or on an external worker, but the repository does
not yet provision:

- private source-object storage;
- a durable remote render-job lease/callback service;
- the immutable public media origin;
- Buffer credentials or channel IDs;
- the recurring worker scheduler; or
- automatic provider analytics ingestion.

Those are deployment and credential steps, not reasons to bypass review or expose the
raw source package. Rendering, immutable hosting, credential configuration, worker
deployment, recurring scheduler operation, final review, and enabling delivery remain
operator responsibilities; the checked-in code does not publish social posts on its
own.
