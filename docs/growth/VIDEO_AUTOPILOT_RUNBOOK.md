# FirstKnock video-source sanitizer

## Purpose

The sanitizer converts exact private screen recordings into deterministic,
content-addressed video donor candidates. It is a local privacy boundary, not an
approval system:

- raw recordings remain private and are never copied into the repository;
- every source file is identified by an opaque filename, byte count, and full SHA-256;
- hard trim boundaries select the exact authoritative raw-frame interval and exclude
  every frame at or after its end index;
- opaque masks use raw-source pixels and authoritative frame intervals; the recorded
  raw-source millisecond values must still match the probed frame timestamps;
- masks are applied before crop, scale, or padding;
- source audio is discarded; the sanitizer writes a neutral AAC donor track only
  for private normalization, never as the canonical final-rendition audio;
- short approved segments may freeze only their last admitted sanitized frame; and
- every derivative remains inactive and `redaction_required` until complete visual
  frame review promotes it to `safe`.

The checked-in pilot plan is
`config/growth-media/firstknock-video-pilot-sanitize-plan.json`. Seven of its eight
candidates passed derivative review; the visually obstructed refresh-area candidate
is excluded. The supplemental review accepts the remove-accidental-sale derivative
and rejects its other two candidates. The v2 rights-safe review approves eight
replacement video derivatives; those eight plus the accepted supplemental
remove-accidental-sale and pilot analytics-date derivatives form the canonical ten
video donors. Four safe FirstKnock-owned image donors complete the 14-source,
14-concept, 28-artifact weekly pack. Those distinct source hashes cover seven
two-concept days without violating the source cooldown.

## Requirements

- Node.js 20 or later
- FFmpeg and FFprobe on `PATH`
- The private FirstKnock source directory
- A private output directory outside both the source package and the repository

Never upload the raw source directory to a public media host, model provider, or social
scheduler.

## Validate the exact source plan

Validation hashes each raw file before FFprobe can inspect it, verifies the expected
byte count, codec, dimensions, duration, rotation, trim, crop, and mask bounds, and
writes no derivative:

```powershell
$env:FIRSTKNOCK_ASSET_DIR = 'C:\private\FirstKnockAssets'
$env:FIRSTKNOCK_SANITIZED_VIDEO_OUTPUT = 'C:\private\firstknock-video-donors'
npm.cmd run sanitize:growth-video-sources -- --validate-only
```

Use another plan explicitly when needed:

```powershell
npm.cmd run sanitize:growth-video-sources -- --plan C:\private\plan.json --source-dir C:\private\FirstKnockAssets --output-dir C:\private\firstknock-video-donors --validate-only
```

The accepted plan schema is `firstknock-video-sanitize-plan.v1`. The earlier
`growth-video-sanitize-plan.v1` identifier is accepted only for the same exact plan
shape. Source references must be single MP4 or MOV filenames; absolute paths,
subdirectories, symlinks, duplicate raw hashes, and traversal are rejected.

## Render sanitized donor candidates

```powershell
$env:FIRSTKNOCK_ASSET_DIR = 'C:\private\FirstKnockAssets'
$env:FIRSTKNOCK_SANITIZED_VIDEO_OUTPUT = 'C:\private\firstknock-video-donors'
npm.cmd run sanitize:growth-video-sources
```

Output is content-addressed:

```text
<private-output>/
  sha256/
    <full-derived-sha256>-<stable-asset-key>.mp4
  <plan-id>.sanitize-result.json
```

The result uses `growth-video-sanitize-result.v1`. It includes:

- a stable `asset_key`;
- a flat `source_reference` usable with the existing source registry when the
  `sha256` directory is used as the private source directory;
- the complete derivative SHA-256 and byte count;
- raw filename, byte count, hash, codec, dimensions, and duration lineage;
- exact trim, crop, mask, fit, recipe, and environment hashes; and
- an inactive `registry_candidate` that remains `redaction_required`.

It never contains an absolute source or output path. Re-running the same plan with the
same source bytes and FFmpeg environment reuses the exact content-addressed file and
requires the existing result manifest to match byte for byte.

## Mandatory visual release review

The sanitizer does not determine that private text is fully hidden. Before promoting a
candidate:

1. Open the final derivative, not the raw recording.
2. Inspect the first frame, final frame, every transition, every scroll position, and
   the full frozen tail.
3. Confirm every planned mask remains opaque for its full time interval.
4. Confirm no frame at or after a hard end appears.
5. Confirm crop and padding do not expose content outside the intended app region.
6. Confirm the clip contains no name, address, email, phone, route title, Home Base,
   quota state, notification, customer value, or unsupported performance claim.
7. Apply every matching `conditional_exclusion`. If its condition is not visibly
   satisfied, exclude the donor instead of changing the result state.
8. Record the reviewed derivative hash. Only then register the same exact candidate as
   `privacy_status: safe` and `active: true`.

Do not edit a derivative in place. Any mask, trim, crop, source, FFmpeg build, or recipe
change must create a new hash and receive a new complete frame review.

## Technical output contract

- 1080x1920
- H.264 High Profile, 8-bit `yuv420p`
- Constant 30 fps
- 5-15 seconds
- AAC-LC, 48 kHz stereo donor-normalization track; the weekly renderer replaces it
  when producing final renditions
- SDR/Rec.709
- MP4 fast-start
- Full-SHA content-addressed filename
- At most 64 MiB per derivative

The recipe hash binds raw lineage, hard trim, mask coordinates and timing, crop,
short-source behavior, and the sanitizer environment. The environment hash binds the
sanitizer script, FFmpeg and FFprobe builds, and deterministic encoder settings.

## Canonical weekly preflight seed

The video derivative decision records are
`config/growth-media/firstknock-video-pilot-review.json`,
`config/growth-media/firstknock-video-supplement-review.json`, and
`config/growth-media/firstknock-weekly-rights-safe-review.json`. The canonical paired
Instagram/TikTok donor pack is
`config/growth-media/firstknock-weekly-rights-safe-seed.json`, batch
`firstknock-weekly-rights-safe-v2-2026-07`.

The v2 pack schedules two unique concepts per day for seven days. Each concept has one
Instagram rendition and one TikTok rendition, so the operating cadence is two videos
and four platform posts per day. On-screen copy advances progressively from the
problem to the visible FirstKnock behavior and practical benefit. The CTA appears only
on the end card and remains inside the renderer's platform-safe zone.

Final v2 MP4s contain the canonical FirstKnock-owned procedural UI audio baked into
the file as `baked_owned_or_licensed` with recipe
`firstknock-procedural-ui-v1`. Those exact files use automatic audio scheduling:
Buffer submits the baked-audio video automatically, without attaching a platform
sound or requesting a notification workflow. The worker still verifies the returned
Buffer post says `schedulingType=automatic`; a connected channel that falls back to a
phone reminder is stopped for review and does not satisfy the autopilot gate. For
TikTok through Buffer, keep the
caption at or below 2,200 characters and use no more than five hashtags, as documented
in [Buffer's TikTok publishing guide](https://support.buffer.com/article/559-using-tiktok-with-buffer).

Stage the exact 14 audited source files into a new empty private directory:

```powershell
$env:FIRSTKNOCK_RAW_ASSET_DIR = 'C:\private\FirstKnockAssets'
$env:FIRSTKNOCK_PILOT_SANITIZED_VIDEO_OUTPUT = 'C:\private\firstknock-pilot-sanitized'
$env:FIRSTKNOCK_SUPPLEMENT_SANITIZED_VIDEO_OUTPUT = 'C:\private\firstknock-supplement-sanitized'
$env:FIRSTKNOCK_WEEKLY_RIGHTS_SAFE_VIDEO_OUTPUT = 'C:\private\firstknock-weekly-rights-safe'
$env:FIRSTKNOCK_WEEKLY_SOURCE_DIR = 'C:\private\firstknock-weekly-sources'
npm.cmd run stage:growth-weekly-sources
```

The staging step verifies every expected hash, rejects wrong-root or duplicate files,
and writes a path-free receipt. See
[`RENDERER_RUNBOOK.md`](./RENDERER_RUNBOOK.md#validate-the-pack) for its direct-script
form and full failure boundary.

Validate the exact source bytes and creative contract without rendering:

```powershell
npm.cmd run render:growth-pack -- --manifest config\growth-media\firstknock-weekly-rights-safe-seed.json --source-dir C:\private\firstknock-weekly-sources --output-dir C:\private\firstknock-weekly-render --validate-only
```

The canonical normalized weekly-pack SHA-256 is:

```text
00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0
```

Set that exact value in `GROWTH_RENDER_PACK_SHA256S` only after deploying the matching
code and making the audited source bytes available to the renderer. The hash allowlist
enables measured generation; it does not authorize rendering, hosting, review,
scheduling, or publication. The final canonical v2 local render produced 28 of 28
immutable, content-addressed H.264 outputs outside the repository. The unhosted
render-result SHA-256 is
`e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff`,
and the renderer-environment SHA-256 is
`89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f`.
The latest deterministic seven-day dry-run evidence SHA-256 is
`6be2b453b22d5b7130c62901e3317b0ac9972ef1219972661b407600de71bf4c`.
These local results do not authorize external storage or distribution. Hosting
remains pending and unauthorized, and the canonical v2 files are not hosted,
imported, publication-approved, scheduled, or published.

The older `config/growth-media/firstknock-weekly-video-seed.json`, canonical SHA-256
`1323a3d47f2a92299bb76ad4ee5d352b6af6114a6b136833fda268fdf7bf4eca`,
is retired blocked audit history. Never use it for rendering, hosting, import,
scheduling, or publication.

## Base44-native hosting handoff

Keep the ten sanitized video donors and four image sources private. Only the 28 exact
weekly rendition outputs may cross into Base44 public media storage. All 28 final v2
outputs exist locally, but hosting remains pending and unauthorized until an owner
explicitly authorizes the exact immutable handoff. No weekly rendition is currently
hosted.

The host command enforces that authorization with an explicit external
`growth-media-hosting-authorization.v1` JSON file. The review must bind the exact
unhosted render-result file SHA-256, normalized pack SHA-256, renderer-environment
SHA-256, and every publish candidate's artifact key and media SHA-256. It must also be
deterministically serialized, contain unique and complete artifact entries, set
`review_status` to `authorized` and `hosting_authorized` to `true`, name the reviewer
and UTC review time, and contain no unresolved blockers. Missing, pending, false,
mismatched, duplicate, or tampered reviews fail before Deno, Base44 authentication, or
upload.

The checked-in
[`firstknock-weekly-hosting-review.json`](../../config/growth-media/firstknock-weekly-hosting-review.json)
exactly binds the v2 batch, unhosted result, pack, renderer environment, and all 28
artifact/media hashes. It is machine-readable evidence of the current state, not
authorization. It remains `pending` with `hosting_authorized: false` only because
`owner_hosting_authorization_required` is unresolved. An authorized owner must create
a separate external review file for the unchanged render result. Never edit the
pending repository file to bypass that gate.

The v2 sources and final renditions contain no map or geography promotional-rights
blocker. Any future source that introduces embedded third-party imagery requires a new
rights review; that generic rule is not an unresolved blocker for this batch.

For every publish candidate, preserve the renderer's exact `delivery_key` and upload
the local file with `basename(delivery_key)` as its `File.name`. A valid basename is:

```text
<64-character-media-sha256>-<artifact-key>.mp4
```

Base44 can prepend an opaque value to the returned filename. That is accepted only when
the URL uses the configured exact HTTPS origin, is one direct child of the configured
app pathname prefix, and its final path segment ends with the complete delivery
basename. The prefix is required and app-scoped, for example:

```text
GROWTH_MEDIA_ORIGIN=https://media.base44.com
GROWTH_MEDIA_PATH_PREFIX=/files/public/695eb764b077190880be21de/
```

Do not accept a different app prefix, nested path, redirect, signed query string, URL
fragment, percent-encoded path, filename with a changed artifact key, or filename that
only contains a partial digest. After upload, run the origin verifier against the
hosted render result with the same exact prefix. It preserves the direct-`200`,
`video/mp4`, exact-byte-count, and full-SHA checks before dashboard import.

PowerShell handoff:

```powershell
$env:FIRSTKNOCK_RENDER_RESULT = 'C:\private\firstknock-weekly-render\firstknock-weekly-rights-safe-v2-2026-07.render-result.json'
$env:FIRSTKNOCK_RENDER_OUTPUT = 'C:\private\firstknock-weekly-render'
$env:FIRSTKNOCK_HOSTING_REVIEW_FILE = 'C:\private\firstknock-weekly-hosting-review.authorized.json'
$env:GROWTH_MEDIA_PATH_PREFIX = '/files/public/695eb764b077190880be21de/'
npm.cmd run host:growth-media:base44
npm.cmd run verify:growth-media-origin -- --result C:\private\firstknock-weekly-render\firstknock-weekly-rights-safe-v2-2026-07.hosted-render-result.json
```

The host command keeps the unhosted result unchanged and writes a resumable
`growth-media-base44-hosting-receipt.v1` receipt beside the hosted result. The receipt
binds the external authorization review ID and SHA-256 so a resume cannot silently
switch reviews. An optional `FIRSTKNOCK_BASE44_HOST_TIMEOUT_MS` bounds the upload
handoff. Hosting authorization permits only this immutable-storage handoff; a
successful upload and origin verification still do not approve or schedule any of the
28 renditions.

The renderer supports Node.js 20, but the pinned Base44 CLI used by the host command
requires Node.js 20.19 or later. The command also requires Deno and an authenticated
Base44 CLI session for app `695eb764b077190880be21de`; missing prerequisites fail
closed before a hosted result is accepted.

After Base44 returns a namespace-valid URL, the receipt checkpoints that file as
`uploaded_pending_verification`. If the CDN is not ready or the process is interrupted,
rerun the same command: it verifies the saved URL and does not upload that file again.
Only direct `200`, `video/mp4`, exact byte count, and full-SHA verification can promote
the entry to `hosted` or place the URL in the hosted render result. The receipt checksum
also prevents a changed pending URL from being silently trusted.
