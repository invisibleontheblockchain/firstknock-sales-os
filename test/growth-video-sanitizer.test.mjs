import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildSanitizedVideoFilter,
  resolveVerifiedRawSource,
  sanitizeGrowthVideoSources,
  snapshotAndProbeRawSource,
  validateAssetAgainstProbe,
  validateSanitizePlan,
} from '../scripts/sanitize-growth-video-sources.mjs';

const AUDIT_PLAN_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-video-pilot-sanitize-plan.json',
);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function samplePlan({
  filename = 'source.mp4',
  bytes = Buffer.from('private-video-source'),
} = {}) {
  return {
    schema_version: 'firstknock-video-sanitize-plan.v1',
    plan_id: 'sanitizer-test-plan',
    purpose: 'Create one deterministic, review-blocked video donor.',
    source_policy: {
      raw_assets_are_private: true,
      raw_assets_are_publishable: false,
      copy_raw_assets_into_repository: false,
      mask_coordinate_space: 'raw_source_pixels',
      mask_timing_space: 'raw_source_milliseconds',
      frame_selection_is_authoritative: true,
      required_release_gate:
        'blocked_until_sanitized_derivative_hash_and_frame_review',
    },
    output_profile: {
      width: 1080,
      height: 1920,
      fps: 30,
      video_codec: 'h264',
      pixel_format: 'yuv420p',
      audio_mode: 'replace_silent_source',
      default_crop: {
        x: 0,
        y: 0,
        width: 320,
        height: 640,
      },
    },
    conditional_exclusions: [{
      safe_derived_asset_key: 'sanitizer-test-safe-v1',
      failure_action: 'exclude_donor',
      reason: 'Exclude if the opaque mask misses any private source pixel.',
    }],
    assets: [{
      pilot_slot: 'day-1-video-1',
      raw_source: {
        filename,
        bytes: bytes.byteLength,
        sha256: hash(bytes),
        duration_ms: 2000,
        width: 320,
        height: 640,
        codec: 'h264',
        raw_privacy_status: 'redaction_required',
      },
      safe_derived_asset_key: 'sanitizer-test-safe-v1',
      title: 'Show one safe product behavior',
      feature_summary:
        'Shows one product control without a customer result or performance claim.',
      rights_status: 'firstknock_owned',
      trim: {
        start_ms: 0,
        end_ms: 1000,
        hard_end: true,
        reject_frames_at_or_after_end: true,
        start_frame_inclusive: 0,
        start_pts_ms: 0,
        end_frame_exclusive: 30,
        end_pts_exclusive_ms: 1000,
      },
      output_duration_ms: 5000,
      short_source_fit: 'freeze_last_frame',
      apply_default_crop: true,
      privacy_masks: [{
        id: 'private-corner',
        effect: 'opaque_brand_black',
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        start_ms: 0,
        end_ms: 1000,
        start_frame_inclusive: 0,
        end_frame_exclusive: 30,
      }],
      release_state:
        'blocked_until_sanitized_derivative_hash_and_frame_review',
    }],
  };
}

function clone(value) {
  return structuredClone(value);
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(Buffer.concat(stderr).toString('utf8')));
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

function ffmpegAvailable() {
  const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
  });
  const ffprobe = spawnSync('ffprobe', ['-version'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  return ffmpeg.status === 0
    && String(ffmpeg.stdout || '').includes('libx264')
    && ffprobe.status === 0;
}

test('checked-in pilot plan satisfies the exact bounded sanitizer contract', async () => {
  const plan = validateSanitizePlan(
    JSON.parse(await readFile(AUDIT_PLAN_PATH, 'utf8')),
  );
  assert.equal(plan.schema_version, 'firstknock-video-sanitize-plan.v1');
  assert.equal(plan.assets.length, 8);
  assert.equal(
    plan.assets.every((asset) => (
      asset.output_duration_ms >= 5000
      && asset.output_duration_ms <= 15000
      && asset.trim.hard_end === true
      && asset.release_state
        === 'blocked_until_sanitized_derivative_hash_and_frame_review'
    )),
    true,
  );
});

test('plan validation rejects traversal, absolute paths, and ambiguous filenames', () => {
  for (const filename of [
    '../source.mp4',
    '..\\source.mp4',
    'nested/source.mp4',
    'nested\\source.mp4',
    'C:\\private\\source.mp4',
    '/private/source.mp4',
    '.source.mp4',
    'source.txt',
  ]) {
    const plan = samplePlan({ filename });
    assert.throws(
      () => validateSanitizePlan(plan),
      /opaque MP4 or MOV filename/,
      filename,
    );
  }
});

test('plan validation binds hashes, output duration, hard trim, masks, and expected bounds', () => {
  const uppercaseHash = samplePlan();
  uppercaseHash.assets[0].raw_source.sha256 =
    uppercaseHash.assets[0].raw_source.sha256.toUpperCase();
  assert.throws(
    () => validateSanitizePlan(uppercaseHash),
    /exact lowercase SHA-256/,
  );

  for (const duration of [4999, 15001, 5000.5]) {
    const plan = samplePlan();
    plan.assets[0].output_duration_ms = duration;
    assert.throws(
      () => validateSanitizePlan(plan),
      /output_duration_ms/,
    );
  }

  const softEnd = samplePlan();
  softEnd.assets[0].trim.hard_end = false;
  assert.throws(
    () => validateSanitizePlan(softEnd),
    /exact, hard, frame-bounded interval/,
  );

  const trimPastDuration = samplePlan();
  trimPastDuration.assets[0].trim.end_ms = 2100;
  trimPastDuration.assets[0].trim.end_pts_exclusive_ms = 2100;
  trimPastDuration.assets[0].trim.end_frame_exclusive = 63;
  trimPastDuration.assets[0].privacy_masks[0].end_ms = 2100;
  trimPastDuration.assets[0].privacy_masks[0].end_frame_exclusive = 63;
  assert.throws(
    () => validateSanitizePlan(trimPastDuration),
    /trim exceeds the expected raw duration/,
  );

  const maskPastWidth = samplePlan();
  maskPastWidth.assets[0].privacy_masks[0].x = 319;
  maskPastWidth.assets[0].privacy_masks[0].width = 2;
  assert.throws(
    () => validateSanitizePlan(maskPastWidth),
    /privacy_masks exceeds the expected raw bounds/,
  );

  const timedMaskPastTrim = samplePlan();
  timedMaskPastTrim.assets[0].privacy_masks[0].end_ms = 1001;
  assert.throws(
    () => validateSanitizePlan(timedMaskPastTrim),
    /stay inside the authoritative trim interval/,
  );
});

test('sanitizer refuses to persist blocked derivatives inside the repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-sanitizer-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const planPath = join(root, 'plan.json');
  await mkdir(sourceDir);
  await writeFile(planPath, `${JSON.stringify(samplePlan(), null, 2)}\n`);

  await assert.rejects(
    () => sanitizeGrowthVideoSources({
      planPath,
      sourceDir,
      outputDir: resolve('.'),
      validateOnly: true,
    }),
    /output directory must stay outside the repository/,
  );
});

test('raw source resolution rejects symlinks and verifies bytes and SHA before decoding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-sanitizer-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const workDir = join(root, 'work');
  await mkdir(sourceDir);
  await mkdir(workDir);
  const sourceBytes = Buffer.from('hash-before-decode');
  const sourcePath = join(sourceDir, 'source.mp4');
  await writeFile(sourcePath, sourceBytes);
  const source = {
    filename: 'source.mp4',
    bytes: sourceBytes.byteLength,
    sha256: hash(sourceBytes),
  };
  const verified = await resolveVerifiedRawSource({ sourceDir, source });
  assert.equal(verified.sha256, source.sha256);
  assert.equal(verified.byteSize, sourceBytes.byteLength);

  let probeCalled = false;
  const plan = validateSanitizePlan(samplePlan({
    filename: 'source.mp4',
    bytes: sourceBytes,
  }));
  plan.assets[0].raw_source.sha256 = '0'.repeat(64);
  await assert.rejects(
    () => snapshotAndProbeRawSource({
      sourceDir,
      asset: plan.assets[0],
      workDir,
      ffprobe: 'ffprobe',
      probeImpl: async () => {
        probeCalled = true;
        return {};
      },
    }),
    /SHA-256 did not match before decoding/,
  );
  assert.equal(probeCalled, false);

  const linkPath = join(sourceDir, 'linked.mp4');
  try {
    await symlink(sourcePath, linkPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.diagnostic('File symlink creation is unavailable; traversal checks still ran.');
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => resolveVerifiedRawSource({
      sourceDir,
      source: {
        filename: 'linked.mp4',
        bytes: sourceBytes.byteLength,
        sha256: hash(sourceBytes),
      },
    }),
    /regular file, never a symlink/,
  );
});

test('probe validation rejects changed dimensions, duration, codec, rotation, crop, and mask bounds', () => {
  const plan = validateSanitizePlan(samplePlan());
  const asset = plan.assets[0];
  const baseProbe = {
    codec: 'h264',
    width: 320,
    height: 640,
    fps: 30,
    duration_ms: 2000,
    start_time_ms: 0,
    rotation: 0,
  };
  assert.equal(
    validateAssetAgainstProbe(asset, baseProbe, plan.output_profile),
    true,
  );
  const framedProbe = {
    ...baseProbe,
    frame_pts_ms: Array.from(
      { length: 61 },
      (_, index) => index * (1000 / 30),
    ),
  };
  assert.equal(
    validateAssetAgainstProbe(asset, framedProbe, plan.output_profile),
    true,
  );
  const shiftedFrames = clone(framedProbe);
  shiftedFrames.frame_pts_ms[30] = 990;
  assert.throws(
    () => validateAssetAgainstProbe(asset, shiftedFrames, plan.output_profile),
    /authoritative trim frames changed/,
  );
  for (const patch of [
    { codec: 'hevc' },
    { width: 321 },
    { height: 641 },
    { duration_ms: 2200 },
    { rotation: 90 },
    { start_time_ms: 100 },
  ]) {
    assert.throws(
      () => validateAssetAgainstProbe(
        asset,
        { ...baseProbe, ...patch },
        plan.output_profile,
      ),
      /raw video metadata did not match the plan/,
    );
  }

  const cropProfile = clone(plan.output_profile);
  cropProfile.default_crop.width = 321;
  assert.throws(
    () => validateAssetAgainstProbe(asset, baseProbe, cropProfile),
    /crop exceeds raw video bounds/,
  );

  const maskAsset = clone(asset);
  maskAsset.privacy_masks[0].height = 641;
  assert.throws(
    () => validateAssetAgainstProbe(maskAsset, baseProbe, plan.output_profile),
    /privacy mask exceeds raw video bounds/,
  );
});

test('filter applies strict hard trim and raw-coordinate masks before crop and scale', () => {
  const plan = validateSanitizePlan(samplePlan());
  const filter = buildSanitizedVideoFilter(
    plan.assets[0],
    plan.output_profile,
  );
  assert.match(filter, /select='gte\(n,0\)\*lt\(n,30\)'/);
  assert.match(filter, /trim=start_frame=0:end_frame=30/);
  assert.match(
    filter,
    /drawbox=x=0:y=0:w=50:h=50:color=0x050705@1:t=fill/,
  );
  assert.match(filter, /enable='gte\(n,0\)\*lt\(n,30\)'/);
  assert.doesNotMatch(filter, /select='gte\(t,/);
  assert.match(filter, /tpad=stop_mode=clone:stop_duration=4/);
  assert.ok(filter.indexOf('select=') < filter.indexOf('drawbox='));
  assert.ok(filter.indexOf('drawbox=') < filter.indexOf('crop='));
  assert.ok(filter.indexOf('crop=') < filter.indexOf('scale='));
  assert.match(filter, /scale=in_range=auto:out_range=tv,format=yuv420p$/);
});

test('real FFmpeg sanitizer masks raw pixels, excludes post-trim frames, freezes safely, and reruns identically', {
  skip: !ffmpegAvailable(),
  timeout: 240_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-sanitizer-ffmpeg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'sources');
  const outputDir = join(root, 'output');
  await mkdir(sourceDir);
  await mkdir(outputDir);
  const sourcePath = join(sourceDir, 'source.mp4');

  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x640:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x640:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000:duration=2',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a:0',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    '2',
    '-movflags',
    '+faststart',
    sourcePath,
  ]);
  const sourceBytes = await readFile(sourcePath);
  const plan = samplePlan({ filename: 'source.mp4', bytes: sourceBytes });
  plan.assets[0].privacy_masks[0].start_ms = 166.667;
  plan.assets[0].privacy_masks[0].end_ms = 666.667;
  plan.assets[0].privacy_masks[0].start_frame_inclusive = 5;
  plan.assets[0].privacy_masks[0].end_frame_exclusive = 20;
  const planPath = join(root, 'plan.json');
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const first = await sanitizeGrowthVideoSources({
    planPath,
    sourceDir,
    outputDir,
  });
  const firstManifest = await readFile(
    join(outputDir, first.result_file),
    'utf8',
  );
  const second = await sanitizeGrowthVideoSources({
    planPath,
    sourceDir,
    outputDir,
  });
  const secondManifest = await readFile(
    join(outputDir, second.result_file),
    'utf8',
  );

  assert.equal(first.sources[0].source_sha256, second.sources[0].source_sha256);
  assert.equal(firstManifest, secondManifest);
  assert.match(first.sources[0].source_reference, new RegExp(
    `^${first.sources[0].source_sha256}-sanitizer-test-safe-v1\\.mp4$`,
  ));
  assert.equal(first.sources[0].source_reference.includes('/'), false);
  assert.equal(first.sources[0].source_reference.includes('\\'), false);
  assert.equal(first.sources[0].privacy_status, 'redaction_required');
  assert.equal(first.sources[0].active, false);
  assert.equal(first.sources[0].registry_candidate.privacy_status, 'redaction_required');
  assert.equal(first.sources[0].registry_candidate.active, false);
  assert.equal(
    JSON.stringify(first).includes(root),
    false,
    'result must not persist absolute source or output paths',
  );
  assert.match(first.sources[0].recipe_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.sanitizer.environment_sha256, /^[a-f0-9]{64}$/);
  assert.ok(Math.abs(first.sources[0].duration_ms - 5000) <= 100);

  const outputPath = join(
    outputDir,
    ...first.sources[0].delivery_key.split('/'),
  );
  const outputInfo = await lstat(outputPath);
  assert.equal(outputInfo.isFile(), true);
  assert.equal(
    hash(await readFile(outputPath)),
    first.sources[0].source_sha256,
  );

  const maskedPixel = await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    '0.25',
    '-i',
    outputPath,
    '-vf',
    'crop=2:2:100:50,scale=1:1,format=rgb24',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.equal(maskedPixel.length >= 3, true);
  assert.equal(
    [...maskedPixel.subarray(0, 3)].every((channel) => channel < 25),
    true,
    'raw-coordinate privacy mask must remain opaque after scaling',
  );

  for (const timestamp of ['0.05', '0.8']) {
    const unmaskedPixel = await run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      timestamp,
      '-i',
      outputPath,
      '-vf',
      'crop=2:2:100:50,scale=1:1,format=rgb24',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    assert.equal(unmaskedPixel.length >= 3, true);
    assert.equal(
      unmaskedPixel[2] > 150
        && unmaskedPixel[0] < 80
        && unmaskedPixel[1] < 80,
      true,
      `frame at ${timestamp}s outside the authoritative mask interval must stay visible`,
    );
  }

  const frozenPixel = await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    '4.5',
    '-i',
    outputPath,
    '-vf',
    'crop=2:2:540:960,scale=1:1,format=rgb24',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.equal(frozenPixel.length >= 3, true);
  const [red, green, blue] = frozenPixel.subarray(0, 3);
  assert.ok(
    blue > red + 50 && blue > green + 20,
    'the frozen tail must use the final safe blue frame, never the red frame at the hard end',
  );

  assert.equal((await stat(outputPath)).size, first.sources[0].byte_size);
});
