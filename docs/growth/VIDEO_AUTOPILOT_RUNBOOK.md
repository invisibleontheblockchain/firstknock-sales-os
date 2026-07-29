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
- source audio is discarded and replaced by silent AAC;
- short approved segments may freeze only their last admitted sanitized frame; and
- every derivative remains inactive and `redaction_required` until complete visual
  frame review promotes it to `safe`.

The checked-in pilot plan is
`config/growth-media/firstknock-video-pilot-sanitize-plan.json`. Seven of its eight
candidates passed derivative review; the visually obstructed refresh-area candidate
is excluded. That supplies three complete two-video days plus one spare. A continuous
seven-day rotation still needs 14 distinct reviewed video donors.

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
- AAC-LC, 48 kHz stereo silent audio
- SDR/Rec.709
- MP4 fast-start
- Full-SHA content-addressed filename
- At most 64 MiB per derivative

The recipe hash binds raw lineage, hard trim, mask coordinates and timing, crop,
short-source behavior, and the sanitizer environment. The environment hash binds the
sanitizer script, FFmpeg and FFprobe builds, and deterministic encoder settings.

## Approved pilot seed

The derivative decision record is
`config/growth-media/firstknock-video-pilot-review.json`. The paired Instagram and
TikTok donor pack is
`config/growth-media/firstknock-video-pilot-seed.json`.

Validate the exact source bytes and creative contract without rendering:

```powershell
npm.cmd run render:growth-pack -- --manifest config\growth-media\firstknock-video-pilot-seed.json --source-dir C:\private\firstknock-video-donors\sha256 --output-dir C:\private\firstknock-video-pilot-render --validate-only
```

The canonical trusted seed-pack SHA-256 is:

```text
6234aa57662eaec2b8ad46279d1f37ee3a855686fbd083347dfa2b4a101e6d81
```

Set that exact value in `GROWTH_RENDER_PACK_SHA256S` only after deploying the matching
code and making the approved derivative bytes available to the renderer. The hash
allowlist enables measured generation; it does not authorize hosting, review,
scheduling, or publication.
