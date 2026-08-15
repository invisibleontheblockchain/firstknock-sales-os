#!/usr/bin/env node

import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  DETERMINISTIC_FFMPEG_CODEC_ARGS,
  DETERMINISTIC_FFMPEG_GLOBAL_ARGS,
  canonicalStringify,
} from './render-growth-pack.mjs';

const PRIMARY_PLAN_SCHEMA = 'firstknock-video-sanitize-plan.v1';
const COMPATIBLE_PLAN_SCHEMAS = new Set([
  PRIMARY_PLAN_SCHEMA,
  'growth-video-sanitize-plan.v1',
]);
const RESULT_SCHEMA = 'growth-video-sanitize-result.v1';
const PROFILE_ID = 'firstknock-video-sanitizer-v1';
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._~-]{0,119}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PLAN_BYTES = 200_000;
const MAX_ASSETS = 50;
const MAX_MASKS = 20;
const MAX_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const MIN_OUTPUT_DURATION_MS = 5_000;
const MAX_OUTPUT_DURATION_MS = 15_000;
const RELEASE_GATE =
  'blocked_until_sanitized_derivative_hash_and_frame_review';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_PLAN_PATH = resolve(
  REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-video-pilot-sanitize-plan.json',
);
const BRAND_BLACK = '0x050705';

function fail(message) {
  const error = new Error(message);
  error.name = 'GrowthVideoSanitizerError';
  throw error;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unsupported fields`);
}

function token(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!TOKEN_PATTERN.test(normalized)) {
    fail(`${label} must be a stable lowercase content token`);
  }
  return normalized;
}

function boundedText(value, label, maximum) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    fail(`${label} must contain 1-${maximum} safe characters`);
  }
  return text;
}

function safeFeatureSummary(value, label) {
  const summary = boundedText(value, label, 1000);
  if (
    /https?:\/\/|www\./i.test(summary)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(summary)
    || /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(
      summary,
    )
  ) {
    fail(`${label} must not contain URLs, email addresses, or phone numbers`);
  }
  return summary;
}

function exactSha256(value, label) {
  const hash = String(value || '').trim();
  if (!SHA256_PATTERN.test(hash)) {
    fail(`${label} must be an exact lowercase SHA-256`);
  }
  return hash;
}

function opaqueFilename(value, label) {
  const filename = String(value || '').trim();
  if (
    !filename
    || filename.length > 240
    || basename(filename) !== filename
    || filename === '.'
    || filename === '..'
    || filename.startsWith('.')
    || /[\\/:]/.test(filename)
    || /[\u0000-\u001f\u007f]/.test(filename)
    || !['.mp4', '.mov'].includes(extname(filename).toLowerCase())
  ) {
    fail(`${label} must be one opaque MP4 or MOV filename, never a path`);
  }
  return filename;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function exactInteger(value, label, minimum, maximum) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function exactNumber(value, label, minimum, maximum) {
  const number = Number(value);
  if (
    !Number.isFinite(number)
    || number < minimum
    || number > maximum
  ) {
    fail(`${label} must be a finite number from ${minimum} through ${maximum}`);
  }
  return number;
}

function normalizeRectangle(value, label) {
  exactKeys(value, new Set(['x', 'y', 'width', 'height']), label);
  return {
    x: exactInteger(value.x, `${label}.x`, 0, 19_999),
    y: exactInteger(value.y, `${label}.y`, 0, 19_999),
    width: exactInteger(value.width, `${label}.width`, 1, 20_000),
    height: exactInteger(value.height, `${label}.height`, 1, 20_000),
  };
}

function normalizeMask(value, index, trim) {
  const label = `privacy_masks[${index}]`;
  exactKeys(
    value,
    new Set([
      'id',
      'effect',
      'x',
      'y',
      'width',
      'height',
      'start_ms',
      'end_ms',
      'start_frame_inclusive',
      'end_frame_exclusive',
    ]),
    label,
  );
  const startMs = exactNumber(
    value.start_ms,
    `${label}.start_ms`,
    0,
    3_600_000,
  );
  const endMs = exactNumber(
    value.end_ms,
    `${label}.end_ms`,
    0,
    3_600_000,
  );
  const startFrame = exactInteger(
    value.start_frame_inclusive,
    `${label}.start_frame_inclusive`,
    0,
    1_000_000,
  );
  const endFrame = exactInteger(
    value.end_frame_exclusive,
    `${label}.end_frame_exclusive`,
    1,
    1_000_001,
  );
  if (
    endMs <= startMs
    || startMs < trim.start_ms
    || endMs > trim.end_ms
    || endFrame <= startFrame
  ) {
    fail(`${label} must stay inside the authoritative trim interval`);
  }
  if (value.effect !== 'opaque_brand_black') {
    fail(`${label}.effect must be opaque_brand_black`);
  }
  return {
    id: token(value.id, `${label}.id`),
    effect: 'opaque_brand_black',
    ...normalizeRectangle({
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    }, label),
    start_ms: startMs,
    end_ms: endMs,
    start_frame_inclusive: startFrame,
    end_frame_exclusive: endFrame,
  };
}

function normalizeTrim(value, label) {
  exactKeys(
    value,
    new Set([
      'start_ms',
      'end_ms',
      'hard_end',
      'reject_frames_at_or_after_end',
      'start_frame_inclusive',
      'start_pts_ms',
      'end_frame_exclusive',
      'end_pts_exclusive_ms',
    ]),
    label,
  );
  const startMs = exactNumber(value.start_ms, `${label}.start_ms`, 0, 3_600_000);
  const endMs = exactNumber(value.end_ms, `${label}.end_ms`, 0, 3_600_000);
  const startPtsMs = exactNumber(
    value.start_pts_ms,
    `${label}.start_pts_ms`,
    0,
    3_600_000,
  );
  const endPtsExclusiveMs = exactNumber(
    value.end_pts_exclusive_ms,
    `${label}.end_pts_exclusive_ms`,
    0,
    3_600_100,
  );
  const startFrame = exactInteger(
    value.start_frame_inclusive,
    `${label}.start_frame_inclusive`,
    0,
    1_000_000,
  );
  const endFrame = exactInteger(
    value.end_frame_exclusive,
    `${label}.end_frame_exclusive`,
    1,
    1_000_001,
  );
  if (
    endMs <= startMs
    || endMs - startMs < 1000 / OUTPUT_FPS
    || value.hard_end !== true
    || endFrame <= startFrame
    || Math.abs(startPtsMs - startMs) > 2
    || endPtsExclusiveMs < endMs
    || endPtsExclusiveMs - endMs > 1000 / OUTPUT_FPS + 2
  ) {
    fail(`${label} must define one exact, hard, frame-bounded interval`);
  }
  return {
    start_ms: startMs,
    end_ms: endMs,
    hard_end: true,
    ...(value.reject_frames_at_or_after_end === true
      ? { reject_frames_at_or_after_end: true }
      : {}),
    start_frame_inclusive: startFrame,
    start_pts_ms: startPtsMs,
    end_frame_exclusive: endFrame,
    end_pts_exclusive_ms: endPtsExclusiveMs,
  };
}

function normalizeRawSource(value, label) {
  exactKeys(
    value,
    new Set([
      'filename',
      'bytes',
      'sha256',
      'duration_ms',
      'width',
      'height',
      'codec',
      'raw_privacy_status',
    ]),
    label,
  );
  const codec = String(value.codec || '').trim().toLowerCase();
  if (!['h264', 'hevc'].includes(codec)) {
    fail(`${label}.codec must be h264 or hevc`);
  }
  return {
    filename: opaqueFilename(value.filename, `${label}.filename`),
    bytes: exactInteger(value.bytes, `${label}.bytes`, 1, MAX_RAW_BYTES),
    sha256: exactSha256(value.sha256, `${label}.sha256`),
    duration_ms: exactNumber(
      value.duration_ms,
      `${label}.duration_ms`,
      1,
      3_600_000,
    ),
    width: exactInteger(value.width, `${label}.width`, 2, 20_000),
    height: exactInteger(value.height, `${label}.height`, 2, 20_000),
    codec,
    raw_privacy_status: token(
      value.raw_privacy_status,
      `${label}.raw_privacy_status`,
    ),
  };
}

function normalizeAsset(value, index) {
  const label = `assets[${index}]`;
  exactKeys(
    value,
    new Set([
      'pilot_slot',
      'raw_source',
      'safe_derived_asset_key',
      'title',
      'feature_summary',
      'rights_status',
      'trim',
      'output_duration_ms',
      'short_source_fit',
      'apply_default_crop',
      'crop',
      'privacy_masks',
      'release_state',
    ]),
    label,
  );
  const trim = normalizeTrim(value.trim, `${label}.trim`);
  const rawSource = normalizeRawSource(value.raw_source, `${label}.raw_source`);
  if (
    trim.end_ms > rawSource.duration_ms
    || trim.end_pts_exclusive_ms > rawSource.duration_ms + 1000 / OUTPUT_FPS + 2
  ) {
    fail(`${label}.trim exceeds the expected raw duration`);
  }
  const outputDurationMs = exactInteger(
    value.output_duration_ms,
    `${label}.output_duration_ms`,
    MIN_OUTPUT_DURATION_MS,
    MAX_OUTPUT_DURATION_MS,
  );
  const shortSourceFit = String(value.short_source_fit || '').trim();
  if (!['none', 'freeze_last_frame'].includes(shortSourceFit)) {
    fail(`${label}.short_source_fit must be none or freeze_last_frame`);
  }
  const trimmedDuration = trim.end_ms - trim.start_ms;
  const frameMs = 1000 / OUTPUT_FPS;
  if (
    shortSourceFit === 'none'
    && (
      trimmedDuration < outputDurationMs
      || trimmedDuration - outputDurationMs > frameMs + 2
    )
  ) {
    fail(`${label} with short_source_fit none must have an exact output-length trim`);
  }
  if (
    shortSourceFit === 'freeze_last_frame'
    && trimmedDuration > outputDurationMs
  ) {
    fail(`${label} cannot freeze a trim longer than its output duration`);
  }
  if (!Array.isArray(value.privacy_masks) || value.privacy_masks.length > MAX_MASKS) {
    fail(`${label}.privacy_masks must contain zero through ${MAX_MASKS} masks`);
  }
  const privacyMasks = value.privacy_masks.map((mask, maskIndex) => (
    normalizeMask(mask, maskIndex, trim)
  ));
  if (new Set(privacyMasks.map((mask) => mask.id)).size !== privacyMasks.length) {
    fail(`${label}.privacy_masks contains duplicate IDs`);
  }
  if (privacyMasks.some((mask) => (
    mask.x + mask.width > rawSource.width
    || mask.y + mask.height > rawSource.height
  ))) {
    fail(`${label}.privacy_masks exceeds the expected raw bounds`);
  }
  if (value.rights_status !== 'firstknock_owned') {
    fail(`${label}.rights_status must be firstknock_owned`);
  }
  if (value.release_state !== RELEASE_GATE) {
    fail(`${label}.release_state must preserve the visual-review release gate`);
  }
  const applyDefaultCrop = exactBoolean(
    value.apply_default_crop,
    `${label}.apply_default_crop`,
  );
  const crop = value.crop == null
    ? null
    : normalizeRectangle(value.crop, `${label}.crop`);
  if (applyDefaultCrop && crop) {
    fail(`${label} cannot combine apply_default_crop with a custom crop`);
  }
  if (
    crop
    && (
      crop.x + crop.width > rawSource.width
      || crop.y + crop.height > rawSource.height
    )
  ) {
    fail(`${label}.crop exceeds the expected raw bounds`);
  }
  return {
    pilot_slot: token(value.pilot_slot, `${label}.pilot_slot`),
    raw_source: rawSource,
    safe_derived_asset_key: token(
      value.safe_derived_asset_key,
      `${label}.safe_derived_asset_key`,
    ),
    title: boundedText(value.title, `${label}.title`, 160),
    feature_summary: safeFeatureSummary(
      value.feature_summary,
      `${label}.feature_summary`,
    ),
    rights_status: 'firstknock_owned',
    trim,
    output_duration_ms: outputDurationMs,
    short_source_fit: shortSourceFit,
    apply_default_crop: applyDefaultCrop,
    ...(crop ? { crop } : {}),
    privacy_masks: privacyMasks,
    release_state: RELEASE_GATE,
  };
}

function normalizeSourcePolicy(value) {
  const label = 'source_policy';
  exactKeys(
    value,
    new Set([
      'raw_assets_are_private',
      'raw_assets_are_publishable',
      'copy_raw_assets_into_repository',
      'mask_coordinate_space',
      'mask_timing_space',
      'frame_selection_is_authoritative',
      'required_release_gate',
    ]),
    label,
  );
  if (
    value.raw_assets_are_private !== true
    || value.raw_assets_are_publishable !== false
    || value.copy_raw_assets_into_repository !== false
    || value.mask_coordinate_space !== 'raw_source_pixels'
    || value.mask_timing_space !== 'raw_source_milliseconds'
    || value.frame_selection_is_authoritative !== true
    || value.required_release_gate !== RELEASE_GATE
  ) {
    fail('source_policy must preserve the private, frame-authoritative release gate');
  }
  return {
    raw_assets_are_private: true,
    raw_assets_are_publishable: false,
    copy_raw_assets_into_repository: false,
    mask_coordinate_space: 'raw_source_pixels',
    mask_timing_space: 'raw_source_milliseconds',
    frame_selection_is_authoritative: true,
    required_release_gate: RELEASE_GATE,
  };
}

function normalizeOutputProfile(value) {
  const label = 'output_profile';
  exactKeys(
    value,
    new Set([
      'width',
      'height',
      'fps',
      'video_codec',
      'pixel_format',
      'audio_mode',
      'default_crop',
    ]),
    label,
  );
  if (
    value.width !== OUTPUT_WIDTH
    || value.height !== OUTPUT_HEIGHT
    || value.fps !== OUTPUT_FPS
    || value.video_codec !== 'h264'
    || value.pixel_format !== 'yuv420p'
    || value.audio_mode !== 'replace_silent_source'
  ) {
    fail('output_profile must use the fixed 1080x1920 H.264 silent profile');
  }
  return {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps: OUTPUT_FPS,
    video_codec: 'h264',
    pixel_format: 'yuv420p',
    audio_mode: 'replace_silent_source',
    default_crop: normalizeRectangle(value.default_crop, `${label}.default_crop`),
  };
}

function normalizeConditionalExclusions(value) {
  if (!Array.isArray(value) || value.length > MAX_ASSETS) {
    fail(`conditional_exclusions must contain zero through ${MAX_ASSETS} rows`);
  }
  return value.map((item, index) => {
    const label = `conditional_exclusions[${index}]`;
    exactKeys(
      item,
      new Set(['safe_derived_asset_key', 'failure_action', 'reason']),
      label,
    );
    if (item.failure_action !== 'exclude_donor') {
      fail(`${label}.failure_action must be exclude_donor`);
    }
    return {
      safe_derived_asset_key: token(
        item.safe_derived_asset_key,
        `${label}.safe_derived_asset_key`,
      ),
      failure_action: 'exclude_donor',
      reason: boundedText(item.reason, `${label}.reason`, 1000),
    };
  });
}

export function validateSanitizePlan(rawPlan) {
  exactKeys(
    rawPlan,
    new Set([
      'schema_version',
      'plan_id',
      'purpose',
      'source_policy',
      'output_profile',
      'conditional_exclusions',
      'assets',
    ]),
    'sanitize plan',
  );
  if (!COMPATIBLE_PLAN_SCHEMAS.has(rawPlan.schema_version)) {
    fail(`sanitize plan must use ${PRIMARY_PLAN_SCHEMA}`);
  }
  if (
    !Array.isArray(rawPlan.assets)
    || rawPlan.assets.length < 1
    || rawPlan.assets.length > MAX_ASSETS
  ) {
    fail(`assets must contain 1-${MAX_ASSETS} video recipes`);
  }
  const normalized = {
    schema_version: rawPlan.schema_version,
    plan_id: token(rawPlan.plan_id, 'plan_id'),
    purpose: boundedText(rawPlan.purpose, 'purpose', 500),
    source_policy: normalizeSourcePolicy(rawPlan.source_policy),
    output_profile: normalizeOutputProfile(rawPlan.output_profile),
    conditional_exclusions: normalizeConditionalExclusions(
      rawPlan.conditional_exclusions,
    ),
    assets: rawPlan.assets.map(normalizeAsset),
  };
  for (const [values, label] of [
    [normalized.assets.map((asset) => asset.pilot_slot), 'pilot slots'],
    [
      normalized.assets.map((asset) => asset.safe_derived_asset_key),
      'derived asset keys',
    ],
    [normalized.assets.map((asset) => asset.raw_source.filename), 'raw filenames'],
    [normalized.assets.map((asset) => asset.raw_source.sha256), 'raw source hashes'],
  ]) {
    if (new Set(values).size !== values.length) {
      fail(`${label} must be unique inside one sanitize plan`);
    }
  }
  const assetKeys = new Set(
    normalized.assets.map((asset) => asset.safe_derived_asset_key),
  );
  if (
    normalized.conditional_exclusions.some(
      (item) => !assetKeys.has(item.safe_derived_asset_key),
    )
  ) {
    fail('conditional_exclusions must reference assets in the same plan');
  }
  return normalized;
}

async function sha256File(path) {
  const digest = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return digest.digest('hex');
}

function inside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ''
    || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

async function exactDirectory(pathValue, label, { create = false } = {}) {
  const absolute = resolve(String(pathValue || ''));
  if (create) await mkdir(absolute, { recursive: true });
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    fail(`${label} must be an available local directory`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} must be a real directory, never a symlink`);
  }
  return { absolute, canonical: await realpath(absolute) };
}

async function privateWorkParent() {
  const directory = await exactDirectory(tmpdir(), 'system temporary directory');
  if (inside(REPOSITORY_ROOT, directory.canonical)) {
    fail('system temporary directory must be outside the repository');
  }
  return directory;
}

export async function resolveVerifiedRawSource({
  sourceDir,
  source,
}) {
  const root = await exactDirectory(sourceDir, 'source directory');
  const filename = opaqueFilename(source?.filename, 'raw source filename');
  const candidate = resolve(root.absolute, filename);
  if (dirname(candidate) !== root.absolute) {
    fail('raw source filename escaped the source directory');
  }
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    fail('raw source file is missing');
  }
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size < 1
    || info.size > MAX_RAW_BYTES
  ) {
    fail('raw source must be one bounded regular file, never a symlink');
  }
  const canonicalCandidate = await realpath(candidate);
  if (!inside(root.canonical, canonicalCandidate)) {
    fail('raw source escaped the source directory');
  }
  const expectedHash = exactSha256(source?.sha256, 'raw source SHA-256');
  if (source?.bytes !== undefined && info.size !== source.bytes) {
    fail('raw source byte size did not match before decoding');
  }
  const observedHash = await sha256File(candidate);
  if (observedHash !== expectedHash) {
    fail('raw source SHA-256 did not match before decoding');
  }
  return {
    path: candidate,
    sha256: observedHash,
    byteSize: info.size,
  };
}

function runCommand(command, args, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxCapture = 4 * 1024 * 1024;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxCapture) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxCapture) stderr.push(chunk);
    });
    child.once('error', () => rejectPromise(
      Object.assign(new Error(`${label} could not start`), {
        name: 'GrowthVideoSanitizerError',
      }),
    ));
    child.once('close', (code) => {
      if (code !== 0 || stdoutBytes > maxCapture || stderrBytes > maxCapture) {
        rejectPromise(
          Object.assign(new Error(`${label} failed`), {
            name: 'GrowthVideoSanitizerError',
          }),
        );
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function rational(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) {
    return 0;
  }
  return numerator / denominator;
}

async function probeVideo(
  path,
  ffprobe,
  label,
  { includeFrameTimeline = false } = {},
) {
  let document;
  try {
    const result = await runCommand(
      ffprobe,
      [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ],
      label,
    );
    document = JSON.parse(result.stdout);
  } catch (error) {
    if (error?.name === 'GrowthVideoSanitizerError') throw error;
    fail(`${label} returned unreadable metadata`);
  }
  const streams = Array.isArray(document?.streams) ? document.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audios = streams.filter((stream) => stream.codec_type === 'audio');
  if (videos.length !== 1) fail(`${label} must contain exactly one video stream`);
  const video = videos[0];
  const durationSeconds = Number(
    document?.format?.duration || video?.duration || 0,
  );
  const rotation = Number(
    video?.tags?.rotate
      || video?.side_data_list?.find((item) => item.rotation !== undefined)?.rotation
      || 0,
  );
  let framePtsMs;
  if (includeFrameTimeline) {
    let frameDocument;
    try {
      const frameResult = await runCommand(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'frame=best_effort_timestamp_time',
          '-of',
          'json',
          path,
        ],
        `${label} frame timeline`,
      );
      frameDocument = JSON.parse(frameResult.stdout);
    } catch (error) {
      if (error?.name === 'GrowthVideoSanitizerError') throw error;
      fail(`${label} returned an unreadable frame timeline`);
    }
    framePtsMs = (Array.isArray(frameDocument?.frames)
      ? frameDocument.frames
      : []).map((frame) => (
      Number(frame?.best_effort_timestamp_time) * 1000
    ));
    if (
      !framePtsMs.length
      || framePtsMs.some((value) => !Number.isFinite(value))
      || framePtsMs.some((value, index) => (
        index > 0 && value <= framePtsMs[index - 1]
      ))
    ) {
      fail(`${label} must have one strictly increasing video frame timeline`);
    }
  }
  return {
    codec: String(video?.codec_name || '').toLowerCase(),
    profile: String(video?.profile || ''),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    pixel_format: String(video?.pix_fmt || '').toLowerCase(),
    color_space: String(video?.color_space || '').toLowerCase(),
    color_transfer: String(video?.color_transfer || '').toLowerCase(),
    color_primaries: String(video?.color_primaries || '').toLowerCase(),
    fps: rational(video?.avg_frame_rate || video?.r_frame_rate),
    duration_ms: Math.round(durationSeconds * 1000),
    start_time_ms: Math.round(Number(video?.start_time || 0) * 1000),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    format_name: String(document?.format?.format_name || '').toLowerCase(),
    byte_size: Number(document?.format?.size || 0),
    audio_streams: audios.map((audio) => ({
      codec: String(audio?.codec_name || '').toLowerCase(),
      sample_rate: Number(audio?.sample_rate || 0),
      channels: Number(audio?.channels || 0),
    })),
    ...(framePtsMs ? { frame_pts_ms: framePtsMs } : {}),
  };
}

export function validateAssetAgainstProbe(asset, probe, outputProfile) {
  const raw = asset.raw_source;
  const frameToleranceMs = probe.fps > 0 ? 1000 / probe.fps + 2 : 2;
  if (
    probe.codec !== raw.codec
    || probe.width !== raw.width
    || probe.height !== raw.height
    || !Number.isFinite(probe.duration_ms)
    || Math.abs(probe.duration_ms - raw.duration_ms) > frameToleranceMs
    || Math.abs(Number(probe.start_time_ms || 0)) > frameToleranceMs
    || Number(probe.rotation || 0) !== 0
    || !Number.isFinite(probe.fps)
    || probe.fps <= 0
    || probe.fps > 240
  ) {
    fail(`${asset.safe_derived_asset_key} raw video metadata did not match the plan`);
  }
  const framePts = Array.isArray(probe.frame_pts_ms)
    ? probe.frame_pts_ms
    : null;
  if (framePts) {
    const startPts = framePts[asset.trim.start_frame_inclusive];
    const endPts = framePts[asset.trim.end_frame_exclusive];
    if (
      !Number.isFinite(startPts)
      || !Number.isFinite(endPts)
      || Math.abs(startPts - asset.trim.start_pts_ms) > 2.5
      || Math.abs(endPts - asset.trim.end_pts_exclusive_ms) > 2.5
    ) {
      fail(`${asset.safe_derived_asset_key} authoritative trim frames changed`);
    }
    for (const mask of asset.privacy_masks) {
      const maskStartPts = framePts[mask.start_frame_inclusive];
      const maskEndPts = framePts[mask.end_frame_exclusive];
      if (
        !Number.isFinite(maskStartPts)
        || !Number.isFinite(maskEndPts)
        || Math.abs(maskStartPts - mask.start_ms) > 2.5
        || Math.abs(maskEndPts - mask.end_ms) > 2.5
      ) {
        fail(`${asset.safe_derived_asset_key} authoritative mask frames changed`);
      }
    }
  }
  if (
    asset.trim.end_ms > probe.duration_ms + frameToleranceMs
    || asset.trim.end_pts_exclusive_ms > probe.duration_ms + frameToleranceMs
  ) {
    fail(`${asset.safe_derived_asset_key} trim exceeds the verified raw duration`);
  }
  const crop = asset.crop || (
    asset.apply_default_crop ? outputProfile.default_crop : null
  );
  if (
    crop
    && (
      crop.x + crop.width > probe.width
      || crop.y + crop.height > probe.height
    )
  ) {
    fail(`${asset.safe_derived_asset_key} crop exceeds raw video bounds`);
  }
  for (const mask of asset.privacy_masks) {
    if (
      mask.x + mask.width > probe.width
      || mask.y + mask.height > probe.height
    ) {
      fail(`${asset.safe_derived_asset_key} privacy mask exceeds raw video bounds`);
    }
  }
  return true;
}

function seconds(milliseconds) {
  return (Number(milliseconds) / 1000)
    .toFixed(6)
    .replace(/0+$/g, '')
    .replace(/\.$/, '') || '0';
}

export function buildSanitizedVideoFilter(asset, outputProfile) {
  const trimStartFrame = asset.trim.start_frame_inclusive;
  const trimEndFrame = asset.trim.end_frame_exclusive;
  const filters = [
    `select='gte(n,${trimStartFrame})*lt(n,${trimEndFrame})'`,
    `trim=start_frame=0:end_frame=${trimEndFrame - trimStartFrame}`,
    'setpts=PTS-STARTPTS',
  ];
  for (const mask of asset.privacy_masks) {
    const relativeStartFrame = Math.max(
      0,
      mask.start_frame_inclusive - trimStartFrame,
    );
    const relativeEndFrame = Math.min(
      trimEndFrame,
      mask.end_frame_exclusive,
    ) - trimStartFrame;
    filters.push(
      `drawbox=x=${mask.x}:y=${mask.y}:w=${mask.width}:h=${mask.height}`
      + `:color=${BRAND_BLACK}@1:t=fill`
      + `:enable='gte(n,${relativeStartFrame})*lt(n,${relativeEndFrame})'`,
    );
  }
  const crop = asset.crop || (
    asset.apply_default_crop ? outputProfile.default_crop : null
  );
  if (crop) {
    filters.push(
      `crop=w=${crop.width}:h=${crop.height}:x=${crop.x}:y=${crop.y}`,
    );
  }
  filters.push(
    `fps=${OUTPUT_FPS}`,
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BRAND_BLACK}`,
  );
  const trimmedDuration = asset.trim.end_ms - asset.trim.start_ms;
  if (
    asset.short_source_fit === 'freeze_last_frame'
    && trimmedDuration < asset.output_duration_ms
  ) {
    filters.push(
      `tpad=stop_mode=clone:stop_duration=${seconds(
        asset.output_duration_ms - trimmedDuration,
      )}`,
    );
  }
  filters.push(
    `trim=duration=${seconds(asset.output_duration_ms)}`,
    `setpts=N/(${OUTPUT_FPS}*TB)`,
    'setsar=1',
    'scale=in_range=auto:out_range=tv',
    'format=yuv420p',
  );
  return filters.join(',');
}

async function snapshotAndProbeRawSource({
  sourceDir,
  asset,
  workDir,
  ffprobe,
  probeImpl = probeVideo,
}) {
  const verified = await resolveVerifiedRawSource({
    sourceDir,
    source: asset.raw_source,
  });
  const snapshotPath = join(
    workDir,
    `raw-source${extname(asset.raw_source.filename).toLowerCase()}`,
  );
  await copyFile(verified.path, snapshotPath, fsConstants.COPYFILE_EXCL);
  if (await sha256File(snapshotPath) !== verified.sha256) {
    fail('raw source changed while creating the private sanitizer snapshot');
  }
  const probe = await probeImpl(
    snapshotPath,
    ffprobe,
    `${asset.safe_derived_asset_key} source probe`,
    { includeFrameTimeline: true },
  );
  return { ...verified, snapshotPath, probe };
}

export { snapshotAndProbeRawSource };

async function resolveSanitizerEnvironment(ffmpeg, ffprobe) {
  const [scriptSha256, ffmpegVersion, ffprobeVersion] = await Promise.all([
    sha256File(SCRIPT_PATH),
    runCommand(ffmpeg, ['-version'], 'FFmpeg version check'),
    runCommand(ffprobe, ['-version'], 'FFprobe version check'),
  ]);
  const settings = {
    profile_id: PROFILE_ID,
    dimensions: [OUTPUT_WIDTH, OUTPUT_HEIGHT],
    fps: OUTPUT_FPS,
    pixel_format: 'yuv420p',
    video_codec: 'libx264',
    video_profile: 'high',
    video_level: '4.1',
    video_bitrate: '8M',
    max_video_bitrate: '10M',
    audio_codec: 'aac',
    audio_sample_rate: 48_000,
    audio_channels: 2,
    audio_bitrate: '128k',
    mask_color: BRAND_BLACK,
    hard_end_expression: 'gte(n,start_frame)*lt(n,end_frame)',
    global_args: DETERMINISTIC_FFMPEG_GLOBAL_ARGS,
    codec_args: DETERMINISTIC_FFMPEG_CODEC_ARGS,
  };
  const environment = {
    profile_id: PROFILE_ID,
    script_sha256: scriptSha256,
    ffmpeg_build_sha256: createHash('sha256')
      .update(ffmpegVersion.stdout.replaceAll('\r\n', '\n').trim())
      .digest('hex'),
    ffprobe_build_sha256: createHash('sha256')
      .update(ffprobeVersion.stdout.replaceAll('\r\n', '\n').trim())
      .digest('hex'),
    settings_sha256: createHash('sha256')
      .update(canonicalStringify(settings))
      .digest('hex'),
  };
  return {
    ...environment,
    environment_sha256: createHash('sha256')
      .update(canonicalStringify(environment))
      .digest('hex'),
  };
}

async function persistContentAddressedOutput({
  temporaryPath,
  outputRoot,
  assetKey,
  mediaSha256,
}) {
  const filename = `${mediaSha256}-${assetKey}.mp4`;
  const directory = join(outputRoot, 'sha256');
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    fail('content-addressed output directory must not be a symlink');
  }
  const finalPath = join(directory, filename);
  const stagingPath = join(
    directory,
    `.sanitizing-${assetKey}-${randomUUID()}.mp4`,
  );
  try {
    await copyFile(temporaryPath, stagingPath, fsConstants.COPYFILE_EXCL);
    if (await sha256File(stagingPath) !== mediaSha256) {
      fail(`${assetKey} sanitized staging output changed before persistence`);
    }
    try {
      await link(stagingPath, finalPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        fail(`${assetKey} sanitized output could not be persisted`);
      }
      const existing = await lstat(finalPath).catch(() => null);
      if (!existing?.isFile() || existing.isSymbolicLink()) {
        fail(`${assetKey} content-addressed output is not a regular file`);
      }
    }
  } finally {
    await rm(stagingPath, { force: true });
  }
  if (await sha256File(finalPath) !== mediaSha256) {
    fail(`${assetKey} content-addressed output collision`);
  }
  return {
    finalPath,
    sourceReference: filename,
    deliveryKey: `sha256/${filename}`,
  };
}

function assertNoAbsolutePaths(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoAbsolutePaths);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(assertNoAbsolutePaths);
    return;
  }
  if (
    typeof value === 'string'
    && (
      isAbsolute(value)
      || /^[a-z]:[\\/]/i.test(value)
      || /^\\\\/.test(value)
    )
  ) {
    fail('sanitize result attempted to persist an absolute path');
  }
}

async function moovPrecedesMdat(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(info.size, 2 * 1024 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    const moov = buffer.indexOf(Buffer.from('moov'));
    const mdat = buffer.indexOf(Buffer.from('mdat'));
    return moov >= 0 && mdat >= 0 && moov < mdat;
  } finally {
    await handle.close();
  }
}

async function verifySanitizedOutput(path, asset, ffprobe) {
  const probe = await probeVideo(
    path,
    ffprobe,
    `${asset.safe_derived_asset_key} sanitized output probe`,
  );
  const audio = probe.audio_streams[0];
  const fastStart = await moovPrecedesMdat(path);
  if (
    probe.codec !== 'h264'
    || String(probe.profile || '').toLowerCase() !== 'high'
    || probe.width !== OUTPUT_WIDTH
    || probe.height !== OUTPUT_HEIGHT
    || probe.pixel_format !== 'yuv420p'
    || Math.abs(probe.fps - OUTPUT_FPS) > 0.01
    || Math.abs(probe.duration_ms - asset.output_duration_ms) > 100
    || probe.audio_streams.length !== 1
    || audio?.codec !== 'aac'
    || audio?.sample_rate !== 48_000
    || audio?.channels !== 2
    || (probe.color_space && probe.color_space !== 'bt709')
    || (probe.color_transfer && probe.color_transfer !== 'bt709')
    || (probe.color_primaries && probe.color_primaries !== 'bt709')
    || !probe.format_name.includes('mp4')
    || !Number.isSafeInteger(probe.byte_size)
    || probe.byte_size < 1
    || probe.byte_size > MAX_OUTPUT_BYTES
    || !fastStart
  ) {
    fail(
      `${asset.safe_derived_asset_key} failed sanitized media verification `
      + canonicalStringify({
        codec: probe.codec,
        profile: probe.profile,
        width: probe.width,
        height: probe.height,
        pixel_format: probe.pixel_format,
        fps: probe.fps,
        duration_ms: probe.duration_ms,
        audio,
        color_space: probe.color_space,
        color_transfer: probe.color_transfer,
        color_primaries: probe.color_primaries,
        format_name: probe.format_name,
        byte_size: probe.byte_size,
        fast_start: fastStart,
      }),
    );
  }
  return probe;
}

async function sanitizeOneAsset({
  asset,
  outputProfile,
  sourceDir,
  outputRoot,
  ffmpeg,
  ffprobe,
  environment,
  conditionalExclusion,
}) {
  const workParent = await privateWorkParent();
  const workDir = await mkdtemp(join(workParent.canonical, 'firstknock-sanitize-'));
  try {
    const source = await snapshotAndProbeRawSource({
      sourceDir,
      asset,
      workDir,
      ffprobe,
    });
    validateAssetAgainstProbe(asset, source.probe, outputProfile);
    const filter = buildSanitizedVideoFilter(asset, outputProfile);
    const temporaryOutput = join(workDir, 'sanitized-output.mp4');
    const durationSeconds = seconds(asset.output_duration_ms);
    await runCommand(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...DETERMINISTIC_FFMPEG_GLOBAL_ARGS,
        '-noautorotate',
        '-i',
        source.snapshotPath,
        '-f',
        'lavfi',
        '-t',
        durationSeconds,
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-filter_complex',
        `[0:v:0]${filter}[outv]`,
        '-map',
        '[outv]',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(OUTPUT_FPS),
        '-fps_mode',
        'cfr',
        '-g',
        String(OUTPUT_FPS * 2),
        '-keyint_min',
        String(OUTPUT_FPS * 2),
        '-sc_threshold',
        '0',
        '-b:v',
        '8M',
        '-maxrate',
        '10M',
        '-bufsize',
        '16M',
        '-c:a',
        'aac',
        ...DETERMINISTIC_FFMPEG_CODEC_ARGS,
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        '-shortest',
        '-t',
        durationSeconds,
        temporaryOutput,
      ],
      `${asset.safe_derived_asset_key} sanitizer render`,
    );
    const technical = await verifySanitizedOutput(
      temporaryOutput,
      asset,
      ffprobe,
    );
    const mediaSha256 = await sha256File(temporaryOutput);
    const persisted = await persistContentAddressedOutput({
      temporaryPath: temporaryOutput,
      outputRoot,
      assetKey: asset.safe_derived_asset_key,
      mediaSha256,
    });
    const byteSize = (await stat(persisted.finalPath)).size;
    const rawLineage = {
      source_reference: asset.raw_source.filename,
      source_sha256: asset.raw_source.sha256,
      byte_size: source.byteSize,
      codec: source.probe.codec,
      width: source.probe.width,
      height: source.probe.height,
      duration_ms: source.probe.duration_ms,
    };
    const recipe = {
      trim: asset.trim,
      output_duration_ms: asset.output_duration_ms,
      short_source_fit: asset.short_source_fit,
      apply_default_crop: asset.apply_default_crop,
      ...(asset.crop ? { crop: asset.crop } : {}),
      ...(asset.apply_default_crop
        ? { default_crop: outputProfile.default_crop }
        : {}),
      privacy_masks: asset.privacy_masks,
      hard_end_expression: 'gte(n,start_frame)*lt(n,end_frame)',
      environment_sha256: environment.environment_sha256,
    };
    const recipeSha256 = createHash('sha256')
      .update(canonicalStringify({
        asset_key: asset.safe_derived_asset_key,
        raw_lineage: rawLineage,
        recipe,
      }))
      .digest('hex');
    return {
      pilot_slot: asset.pilot_slot,
      asset_key: asset.safe_derived_asset_key,
      title: asset.title,
      feature_summary: asset.feature_summary,
      rights_status: asset.rights_status,
      release_state: RELEASE_GATE,
      privacy_status: 'redaction_required',
      active: false,
      source_reference: persisted.sourceReference,
      source_sha256: mediaSha256,
      delivery_key: persisted.deliveryKey,
      media_kind: 'video',
      mime_type: 'video/mp4',
      codec: 'h264',
      width: technical.width,
      height: technical.height,
      duration_ms: technical.duration_ms,
      byte_size: byteSize,
      audio_mode: 'silent',
      raw_lineage: rawLineage,
      sanitization_recipe: recipe,
      recipe_sha256: recipeSha256,
      ...(conditionalExclusion
        ? { conditional_exclusion: conditionalExclusion }
        : {}),
      registry_candidate: {
        asset_key: asset.safe_derived_asset_key,
        title: asset.title,
        source_reference: persisted.sourceReference,
        media_kind: 'video',
        mime_type: 'video/mp4',
        width: technical.width,
        height: technical.height,
        duration_ms: technical.duration_ms,
        source_sha256: mediaSha256,
        privacy_status: 'redaction_required',
        safe_summary: asset.feature_summary,
        privacy_note:
          'Sanitized derivative requires complete frame review before promotion to safe.',
        active: false,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function writeIdempotentResult(outputRoot, planId, result) {
  assertNoAbsolutePaths(result);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_PLAN_BYTES) {
    fail('sanitize result exceeded its bounded manifest size');
  }
  const filename = `${planId}.sanitize-result.json`;
  const resultPath = join(outputRoot, filename);
  const stagingPath = join(
    outputRoot,
    `.${planId}.${randomUUID()}.sanitize-result.tmp`,
  );
  try {
    await writeFile(stagingPath, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      await link(stagingPath, resultPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('sanitize result could not be persisted');
      const resultInfo = await lstat(resultPath).catch(() => null);
      if (!resultInfo?.isFile() || resultInfo.isSymbolicLink()) {
        fail('sanitize result target must be one regular file');
      }
      const existing = await readFile(resultPath, 'utf8').catch(() => '');
      if (existing !== serialized) {
        fail('sanitize result filename already exists with different content');
      }
    }
  } finally {
    await rm(stagingPath, { force: true });
  }
  return { resultPath, filename };
}

export async function sanitizeGrowthVideoSources({
  planPath = DEFAULT_PLAN_PATH,
  sourceDir,
  outputDir,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  validateOnly = false,
} = {}) {
  if (!sourceDir) fail('--source-dir is required');
  if (!outputDir) fail('--output-dir is required');
  const planFile = resolve(String(planPath || ''));
  const planInfo = await lstat(planFile).catch(() => null);
  if (
    !planInfo?.isFile()
    || planInfo.isSymbolicLink()
    || planInfo.size < 1
    || planInfo.size > MAX_PLAN_BYTES
  ) {
    fail('sanitize plan must be one bounded JSON file');
  }
  let rawPlan;
  try {
    rawPlan = JSON.parse(await readFile(planFile, 'utf8'));
  } catch {
    fail('sanitize plan must contain valid JSON');
  }
  const plan = validateSanitizePlan(rawPlan);
  const planSha256 = createHash('sha256')
    .update(canonicalStringify(plan))
    .digest('hex');
  const requestedSourceRoot = resolve(String(sourceDir || ''));
  const requestedOutputRoot = resolve(String(outputDir || ''));
  if (inside(REPOSITORY_ROOT, requestedOutputRoot)) {
    fail('output directory must stay outside the repository');
  }
  if (inside(requestedSourceRoot, requestedOutputRoot)) {
    fail('output directory must stay outside the private raw source directory');
  }
  const [sourceRoot, outputRoot, environment] = await Promise.all([
    exactDirectory(sourceDir, 'source directory'),
    exactDirectory(outputDir, 'output directory', { create: true }),
    resolveSanitizerEnvironment(ffmpeg, ffprobe),
  ]);
  if (inside(sourceRoot.canonical, outputRoot.canonical)) {
    fail('output directory must stay outside the private raw source directory');
  }
  if (inside(REPOSITORY_ROOT, outputRoot.canonical)) {
    fail('output directory must stay outside the repository');
  }
  const exclusionByAsset = new Map(
    plan.conditional_exclusions.map((item) => [
      item.safe_derived_asset_key,
      item,
    ]),
  );
  if (validateOnly) {
    for (const asset of plan.assets) {
      const workParent = await privateWorkParent();
      const workDir = await mkdtemp(join(workParent.canonical, 'firstknock-validate-'));
      try {
        const source = await snapshotAndProbeRawSource({
          sourceDir: sourceRoot.absolute,
          asset,
          workDir,
          ffprobe,
        });
        validateAssetAgainstProbe(asset, source.probe, plan.output_profile);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
    return {
      schema_version: RESULT_SCHEMA,
      status: 'validated',
      plan_id: plan.plan_id,
      plan_sha256: planSha256,
      asset_count: plan.assets.length,
      environment,
    };
  }
  const sources = [];
  for (const asset of plan.assets) {
    sources.push(await sanitizeOneAsset({
      asset,
      outputProfile: plan.output_profile,
      sourceDir: sourceRoot.absolute,
      outputRoot: outputRoot.absolute,
      ffmpeg,
      ffprobe,
      environment,
      conditionalExclusion: exclusionByAsset.get(asset.safe_derived_asset_key),
    }));
  }
  const result = {
    schema_version: RESULT_SCHEMA,
    plan_schema_version: plan.schema_version,
    plan_id: plan.plan_id,
    plan_sha256: planSha256,
    release_state: RELEASE_GATE,
    output_profile: plan.output_profile,
    sanitizer: environment,
    source_count: sources.length,
    sources,
  };
  const persisted = await writeIdempotentResult(
    outputRoot.absolute,
    plan.plan_id,
    result,
  );
  return {
    ...result,
    result_file: persisted.filename,
  };
}

function parseArgs(argv) {
  const options = {
    planPath:
      process.env.FIRSTKNOCK_VIDEO_SANITIZE_PLAN || DEFAULT_PLAN_PATH,
    sourceDir: process.env.FIRSTKNOCK_ASSET_DIR || '',
    outputDir: process.env.FIRSTKNOCK_SANITIZED_VIDEO_OUTPUT || '',
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--validate-only') {
      options.validateOnly = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`${value} requires a value`);
    if (value === '--plan') options.planPath = next;
    else if (value === '--source-dir') options.sourceDir = next;
    else if (value === '--output-dir') options.outputDir = next;
    else if (value === '--ffmpeg') options.ffmpeg = next;
    else if (value === '--ffprobe') options.ffprobe = next;
    else fail(`Unknown argument: ${value}`);
    index += 1;
  }
  return options;
}

async function main() {
  const result = await sanitizeGrowthVideoSources(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({
    status: result.status || 'sanitized',
    plan_id: result.plan_id,
    asset_count: result.asset_count ?? result.source_count,
    ...(result.result_file ? { result_file: result.result_file } : {}),
  }, null, 2)}\n`);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === SCRIPT_PATH
) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
