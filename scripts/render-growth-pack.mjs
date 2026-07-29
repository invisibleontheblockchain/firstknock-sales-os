#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PACK_SCHEMA = 'growth-render-pack.v1';
const RESULT_SCHEMA = 'growth-render-result.v1';
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._~-]{0,119}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_SOURCE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_SOURCE_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);
const PLATFORMS = new Set(['instagram', 'tiktok']);
const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;
const RENDERER_PROFILE_ID = 'firstknock-h264-bitexact-v2';
export const DETERMINISTIC_FFMPEG_GLOBAL_ARGS = Object.freeze([
  '-fflags',
  '+bitexact',
  '-filter_threads',
  '1',
  '-filter_complex_threads',
  '1',
]);
export const DETERMINISTIC_FFMPEG_CODEC_ARGS = Object.freeze([
  '-threads:v',
  '1',
  '-threads:a',
  '1',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact',
]);
const RENDERER_SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_MANIFEST = resolve(
  dirname(RENDERER_SCRIPT_PATH),
  '..',
  'config',
  'growth-media',
  'firstknock-safe-starter.json',
);

function fail(message) {
  const error = new Error(message);
  error.name = 'GrowthRenderError';
  throw error;
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalStringify(nested)}`)
    .join(',')}}`;
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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

function cleanToken(value, label) {
  const token = String(value || '').trim().toLowerCase();
  if (!TOKEN_PATTERN.test(token)) fail(`${label} is not a valid content token`);
  return token;
}

function nonemptyText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) {
    fail(`${label} must contain 1-${maxLength} characters`);
  }
  return text;
}

function exactInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function optionalBoolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function simpleFilename(value, label) {
  const name = String(value || '').trim();
  if (
    !name
    || basename(name) !== name
    || name === '.'
    || name === '..'
    || /[\\/]/.test(name)
  ) {
    fail(`${label} must be an opaque filename, never a path`);
  }
  return name;
}

function validateTrackedUrl(value, artifact) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail(`${artifact.artifact_key}.cta_url must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || url.origin !== 'https://firstknock.online'
    || url.pathname !== '/start'
    || url.searchParams.get('utm_source') !== artifact.platform
    || url.searchParams.get('utm_medium') !== 'organic_social'
    || url.searchParams.get('utm_campaign') !== artifact.campaign
    || url.searchParams.get('utm_content') !== artifact.platform_content_id
  ) {
    fail(`${artifact.artifact_key}.cta_url does not match its canonical /start attribution`);
  }
  const allowed = new Set([
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
  ]);
  const counts = new Map();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      fail(`${artifact.artifact_key}.cta_url contains an unsupported query parameter`);
    }
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  if (
    allowed.size !== counts.size
    || [...allowed].some((key) => counts.get(key) !== 1)
  ) {
    fail(`${artifact.artifact_key}.cta_url must contain each canonical attribution parameter exactly once`);
  }
  return url.toString();
}

function normalizeMediaOrigin(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    fail('--media-origin must be an exact public HTTPS origin');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
    || url.hostname === 'localhost'
    || url.hostname.endsWith('.localhost')
    || url.hostname.includes(':')
  ) {
    fail('--media-origin must be an exact public HTTPS origin');
  }
  return url.origin;
}

function countWords(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}

export function validatePack(rawPack) {
  if (!rawPack || typeof rawPack !== 'object' || Array.isArray(rawPack)) {
    fail('The render pack must be a JSON object');
  }
  if (rawPack.schema_version !== PACK_SCHEMA) {
    fail(`schema_version must be ${PACK_SCHEMA}`);
  }
  const batchId = cleanToken(rawPack.batch_id, 'batch_id');
  const template = rawPack.template || {};
  const output = rawPack.output || {};
  const normalizedTemplate = {
    id: cleanToken(template.id, 'template.id'),
    version: nonemptyText(template.version, 'template.version', 40),
    brand: nonemptyText(template.brand, 'template.brand', 60),
    accent_color: /^0x[a-fA-F0-9]{6}$/.test(String(template.accent_color || ''))
      ? `0x${String(template.accent_color).slice(2).toUpperCase()}`
      : fail('template.accent_color must use 0xRRGGBB'),
    background_color: /^0x[a-fA-F0-9]{6}$/.test(String(template.background_color || ''))
      ? `0x${String(template.background_color).slice(2).toUpperCase()}`
      : fail('template.background_color must use 0xRRGGBB'),
    hook_font_size: exactInteger(template.hook_font_size, 'template.hook_font_size', 40, 110),
    cta_font_size: exactInteger(template.cta_font_size, 'template.cta_font_size', 24, 64),
    disclosure_font_size: exactInteger(
      template.disclosure_font_size,
      'template.disclosure_font_size',
      18,
      36,
    ),
  };
  const normalizedOutput = {
    width: exactInteger(output.width, 'output.width', 1080, 1080),
    height: exactInteger(output.height, 'output.height', 1920, 1920),
    fps: exactInteger(output.fps, 'output.fps', 30, 30),
    duration_ms: exactInteger(output.duration_ms, 'output.duration_ms', 5000, 60000),
    video_bitrate: nonemptyText(output.video_bitrate, 'output.video_bitrate', 12),
    max_video_bitrate: nonemptyText(
      output.max_video_bitrate,
      'output.max_video_bitrate',
      12,
    ),
    audio_bitrate: nonemptyText(output.audio_bitrate, 'output.audio_bitrate', 12),
    thumbnail_offset_ms: exactInteger(
      output.thumbnail_offset_ms,
      'output.thumbnail_offset_ms',
      0,
      Number(output.duration_ms || 0) - 1,
    ),
    audio_mode: output.audio_mode === 'silent'
      ? 'silent'
      : fail('output.audio_mode must be silent until licensed audio evidence is implemented'),
  };
  if (!/^[1-9][0-9]*[kKmM]$/.test(normalizedOutput.video_bitrate)) {
    fail('output.video_bitrate must be an FFmpeg bitrate such as 8M');
  }
  if (!/^[1-9][0-9]*[kKmM]$/.test(normalizedOutput.max_video_bitrate)) {
    fail('output.max_video_bitrate must be an FFmpeg bitrate such as 10M');
  }
  if (!/^[1-9][0-9]*[kKmM]$/.test(normalizedOutput.audio_bitrate)) {
    fail('output.audio_bitrate must be an FFmpeg bitrate such as 128k');
  }

  if (!Array.isArray(rawPack.sources) || rawPack.sources.length < 1) {
    fail('sources must contain at least one audited source');
  }
  const sources = rawPack.sources.map((source, index) => {
    const prefix = `sources[${index}]`;
    const normalized = {
      asset_key: cleanToken(source.asset_key, `${prefix}.asset_key`),
      source_origin: cleanToken(
        source.source_origin || 'asset_pack',
        `${prefix}.source_origin`,
      ),
      source_reference: simpleFilename(source.source_reference, `${prefix}.source_reference`),
      source_sha256: String(source.source_sha256 || '').trim().toLowerCase(),
      media_kind: source.media_kind,
      mime_type: String(source.mime_type || '').trim().toLowerCase(),
      codec: String(source.codec || '').trim().toLowerCase(),
      width: exactInteger(source.width, `${prefix}.width`, 1, 20000),
      height: exactInteger(source.height, `${prefix}.height`, 1, 20000),
      duration_ms: source.media_kind === 'video'
        ? exactInteger(source.duration_ms, `${prefix}.duration_ms`, 1, 3600000)
        : 0,
      privacy_status: source.privacy_status,
      rights_status: source.rights_status,
    };
    if (!SHA256_PATTERN.test(normalized.source_sha256)) {
      fail(`${prefix}.source_sha256 must be a complete lowercase SHA-256`);
    }
    if (
      !['image', 'video'].includes(normalized.media_kind)
      || (
        normalized.media_kind === 'image'
        && !IMAGE_SOURCE_MIME_TYPES.has(normalized.mime_type)
      )
      || (
        normalized.media_kind === 'video'
        && (
          !VIDEO_SOURCE_MIME_TYPES.has(normalized.mime_type)
          || !['h264', 'hevc'].includes(normalized.codec)
        )
      )
      || !['asset_pack', 'repository_public'].includes(normalized.source_origin)
      || !['safe', 'redaction_required'].includes(normalized.privacy_status)
      || normalized.rights_status !== 'firstknock_owned'
    ) {
      fail(`${prefix} is not eligible for the safe v1 renderer`);
    }
    return normalized;
  });
  unique(sources.map((source) => source.asset_key), 'source asset keys');
  unique(
    sources.map((source) => (
      `${source.source_origin}:${source.source_reference.toLowerCase()}`
    )),
    'source references',
  );
  const sourceByKey = new Map(sources.map((source) => [source.asset_key, source]));

  if (!Array.isArray(rawPack.artifacts) || rawPack.artifacts.length < 1) {
    fail('artifacts must contain at least one rendition');
  }
  const artifacts = rawPack.artifacts.map((artifact, index) => {
    const prefix = `artifacts[${index}]`;
    const sourceAssetKey = cleanToken(
      artifact.source_asset_key,
      `${prefix}.source_asset_key`,
    );
    const source = sourceByKey.get(sourceAssetKey);
    const aiGenerated = optionalBoolean(
      artifact.ai_generated,
      `${prefix}.ai_generated`,
    );
    const renderValue = artifact.render && typeof artifact.render === 'object'
      ? artifact.render
      : {};
    const cropValue = renderValue.crop && typeof renderValue.crop === 'object'
      ? renderValue.crop
      : null;
    const render = {
      duration_ms: renderValue.duration_ms === undefined
        ? normalizedOutput.duration_ms
        : exactInteger(renderValue.duration_ms, `${prefix}.render.duration_ms`, 5000, 60000),
      trim_start_ms: renderValue.trim_start_ms === undefined
        ? 0
        : exactInteger(
          renderValue.trim_start_ms,
          `${prefix}.render.trim_start_ms`,
          0,
          Math.max(0, Number(source?.duration_ms || 0) - 1),
        ),
      trim_end_ms: renderValue.trim_end_ms === undefined
        ? Number(source?.duration_ms || 0)
        : exactInteger(
          renderValue.trim_end_ms,
          `${prefix}.render.trim_end_ms`,
          Number(source?.duration_ms || 0) > 0 ? 1 : 0,
          Math.max(0, Number(source?.duration_ms || 0)),
        ),
      crop: cropValue
        ? {
          x: exactInteger(cropValue.x, `${prefix}.render.crop.x`, 0, 19999),
          y: exactInteger(cropValue.y, `${prefix}.render.crop.y`, 0, 19999),
          width: exactInteger(cropValue.width, `${prefix}.render.crop.width`, 2, 20000),
          height: exactInteger(cropValue.height, `${prefix}.render.crop.height`, 2, 20000),
        }
        : null,
      privacy_recipe_id: renderValue.privacy_recipe_id
        ? cleanToken(
          renderValue.privacy_recipe_id,
          `${prefix}.render.privacy_recipe_id`,
        )
        : '',
    };
    const normalized = {
      artifact_key: cleanToken(artifact.artifact_key, `${prefix}.artifact_key`),
      concept_id: cleanToken(artifact.concept_id, `${prefix}.concept_id`),
      platform: String(artifact.platform || '').trim().toLowerCase(),
      platform_content_id: cleanToken(
        artifact.platform_content_id,
        `${prefix}.platform_content_id`,
      ),
      campaign: cleanToken(artifact.campaign, `${prefix}.campaign`),
      title: nonemptyText(artifact.title, `${prefix}.title`, 160),
      pillar: nonemptyText(artifact.pillar, `${prefix}.pillar`, 120),
      format: artifact.format,
      ...(aiGenerated ? { ai_generated: true } : {}),
      distribution_state: String(
        artifact.distribution_state || 'publish_candidate',
      ).trim().toLowerCase(),
      source_asset_key: sourceAssetKey,
      hook: nonemptyText(artifact.hook, `${prefix}.hook`, 160),
      overlay_text: Array.isArray(artifact.overlay_text)
        ? artifact.overlay_text.map((text, itemIndex) => (
          nonemptyText(text, `${prefix}.overlay_text[${itemIndex}]`, 160)
        )).slice(0, 8)
        : fail(`${prefix}.overlay_text must be an array`),
      shot_list: Array.isArray(artifact.shot_list)
        ? artifact.shot_list.map((text, itemIndex) => (
          nonemptyText(text, `${prefix}.shot_list[${itemIndex}]`, 300)
        )).slice(0, 12)
        : fail(`${prefix}.shot_list must be an array`),
      caption: nonemptyText(artifact.caption, `${prefix}.caption`, 1800),
      cta_label: nonemptyText(artifact.cta_label, `${prefix}.cta_label`, 160),
      cta_url: '',
      overlay_cta: nonemptyText(artifact.overlay_cta, `${prefix}.overlay_cta`, 80),
      disclosure: nonemptyText(artifact.disclosure, `${prefix}.disclosure`, 300),
      render,
    };
    if (!PLATFORMS.has(normalized.platform)) {
      fail(`${prefix}.platform must be instagram or tiktok`);
    }
    if (
      normalized.format !== 'video'
      || normalized.platform_content_id !== normalized.artifact_key
      || !source
      || !['publish_candidate', 'sanitized_preview_only'].includes(
        normalized.distribution_state,
      )
      || normalized.overlay_text.length < 1
      || normalized.shot_list.length < 1
      || countWords(normalized.hook) < 4
      || countWords(normalized.hook) > 7
      || !/demo/i.test(normalized.disclosure)
    ) {
      fail(`${prefix} does not satisfy the safe v1 creative contract`);
    }
    if (
      (
        source.media_kind === 'image'
        && (render.trim_start_ms !== 0 || render.trim_end_ms !== 0)
      )
      || (
        source.media_kind === 'video'
        && (
          render.trim_end_ms <= render.trim_start_ms
          || render.trim_end_ms - render.trim_start_ms < render.duration_ms
        )
      )
      || (
        render.crop
        && (
          render.crop.x + render.crop.width > source.width
          || render.crop.y + render.crop.height > source.height
        )
      )
      || (
        source.privacy_status === 'redaction_required'
        && (
          normalized.distribution_state !== 'sanitized_preview_only'
          ||
          !render.privacy_recipe_id
          || !render.crop
          || source.media_kind !== 'video'
          || render.trim_start_ms <= 0
          || render.trim_end_ms >= source.duration_ms
        )
      )
    ) {
      fail(`${prefix}.render is outside its immutable source bounds`);
    }
    const visibleDisclosure = wrapTextLines(
      normalized.disclosure.toUpperCase(),
      58,
      1,
    );
    if (
      visibleDisclosure.length !== 1
      || visibleDisclosure[0] !== normalized.disclosure.toUpperCase()
      || !/DEMO/.test(visibleDisclosure[0])
    ) {
      fail(`${prefix}.disclosure must fit completely in the visible demo-label line`);
    }
    normalized.cta_url = validateTrackedUrl(artifact.cta_url, normalized);
    return normalized;
  });
  unique(artifacts.map((artifact) => artifact.artifact_key), 'artifact keys');
  unique(
    artifacts.map((artifact) => artifact.platform_content_id),
    'platform content IDs',
  );
  const conceptPlatforms = new Map();
  const sourceUsage = new Map();
  for (const artifact of artifacts) {
    const platforms = conceptPlatforms.get(artifact.concept_id) || [];
    platforms.push(artifact.platform);
    conceptPlatforms.set(artifact.concept_id, platforms);
    sourceUsage.set(
      artifact.source_asset_key,
      Number(sourceUsage.get(artifact.source_asset_key) || 0) + 1,
    );
  }
  for (const [conceptId, platforms] of conceptPlatforms.entries()) {
    if (
      platforms.length !== 2
      || new Set(platforms).size !== 2
      || !platforms.includes('instagram')
      || !platforms.includes('tiktok')
    ) {
      fail(`${conceptId} must have exactly one Instagram and one TikTok rendition`);
    }
  }
  for (const [assetKey, usage] of sourceUsage.entries()) {
    if (usage > 3) fail(`${assetKey} exceeds the three-active-rendition source cap`);
  }

  return {
    schema_version: PACK_SCHEMA,
    batch_id: batchId,
    template: normalizedTemplate,
    output: normalizedOutput,
    sources,
    artifacts,
  };
}

function wrapTextLines(value, maxCharacters, maxLines = 3) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const retained = lines.slice(0, maxLines);
    retained[maxLines - 1] = `${retained[maxLines - 1].slice(
      0,
      Math.max(1, maxCharacters - 1),
    ).trim()}…`;
    return retained;
  }
  return lines;
}

function ffmpegFilterPath(value) {
  return resolve(value)
    .replaceAll('\\', '/')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'");
}

async function firstAccessible(paths) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path);
      return resolve(path);
    } catch {
      // Try the next platform font.
    }
  }
  return '';
}

async function resolveFonts() {
  const bold = await firstAccessible([
    process.env.FIRSTKNOCK_RENDER_FONT_BOLD,
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\segoeuib.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  ]);
  const regular = await firstAccessible([
    process.env.FIRSTKNOCK_RENDER_FONT_REGULAR,
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  ]);
  if (!bold || !regular) {
    fail('No supported render font was found; set FIRSTKNOCK_RENDER_FONT_BOLD and FIRSTKNOCK_RENDER_FONT_REGULAR');
  }
  return { bold, regular };
}

function drawTextFilter({
  fontPath,
  textPath,
  size,
  color,
  x,
  y,
  lineSpacing = 8,
}) {
  return [
    `drawtext=fontfile='${ffmpegFilterPath(fontPath)}'`,
    `textfile='${ffmpegFilterPath(textPath)}'`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `line_spacing=${lineSpacing}`,
    `x=${x}`,
    `y=${y}`,
    'fix_bounds=1',
    'expansion=none',
  ].join(':');
}

async function runCommand(command, args, { sourceDir, outputDir } = {}) {
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  if (result.code !== 0) {
    let detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    for (const sensitivePath of [sourceDir, outputDir].filter(Boolean)) {
      detail = detail.replaceAll(resolve(sensitivePath), '<private-path>');
      detail = detail.replaceAll(resolve(sensitivePath).replaceAll('\\', '/'), '<private-path>');
    }
    fail(`${basename(command)} failed: ${detail.slice(0, 1600)}`);
  }
  return result.stdout;
}

async function writeOverlayText(workDir, artifact, template) {
  const text = {
    brand: [`${template.brand.toUpperCase()}  /  ${artifact.platform.toUpperCase()}`],
    hook: wrapTextLines(artifact.hook.toUpperCase(), 20, 2),
    deck: wrapTextLines(artifact.overlay_text.join('  •  '), 52, 2),
    cta: wrapTextLines(artifact.overlay_cta.toUpperCase(), 34, 1),
    disclosure: wrapTextLines(artifact.disclosure.toUpperCase(), 58, 1),
    identity: [artifact.platform_content_id],
  };
  const paths = {};
  for (const [key, lines] of Object.entries(text)) {
    paths[key] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const path = join(workDir, `${key}-${index}.txt`);
      await writeFile(path, lines[index], 'utf8');
      paths[key].push(path);
    }
  }
  return paths;
}

function appendTextLines(filters, {
  input,
  output,
  paths,
  fontPath,
  size,
  color,
  x,
  y,
  lineHeight,
}) {
  let current = input;
  paths.forEach((textPath, index) => {
    const next = `${output}_${index}`;
    filters.push(`[${current}]${drawTextFilter({
      fontPath,
      textPath,
      size,
      color,
      x,
      y: y + lineHeight * index,
      lineSpacing: 0,
    })}[${next}]`);
    current = next;
  });
  return current;
}

function buildVideoFilter(pack, artifact, source, textPaths, fonts) {
  const { template } = pack;
  const accent = template.accent_color;
  const background = template.background_color;
  const sourceTransforms = [];
  if (source.media_kind === 'video') {
    sourceTransforms.push(
      `trim=start=${(artifact.render.trim_start_ms / 1000).toFixed(3)}:end=${(
        artifact.render.trim_end_ms / 1000
      ).toFixed(3)}`,
      'setpts=PTS-STARTPTS',
    );
  }
  if (artifact.render.crop) {
    sourceTransforms.push(
      `crop=w=${artifact.render.crop.width}:h=${artifact.render.crop.height}:x=${artifact.render.crop.x}:y=${artifact.render.crop.y}`,
    );
  }
  sourceTransforms.push(`fps=${pack.output.fps}`);
  const filters = [
    `[0:v]${sourceTransforms.join(',')},split=2[background_source][card_source]`,
    `[background_source]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=48,eq=brightness=-0.62:saturation=0.72[blurred]`,
    `[card_source]scale=860:1120:force_original_aspect_ratio=decrease,pad=900:1160:(ow-iw)/2:(oh-ih)/2:color=${background}[card]`,
    `[blurred]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.48:t=fill,drawbox=x=0:y=0:w=18:h=ih:color=${accent}@0.95:t=fill,drawbox=x=84:y=364:w=912:h=1172:color=white@0.14:t=2[base]`,
    "[base][card]overlay=x='90+4*sin(t*0.60)':y='370+5*sin(t*0.45)':eval=frame[composite]",
  ];
  let current = appendTextLines(filters, {
    input: 'composite',
    output: 'brand',
    paths: textPaths.brand,
    fontPath: fonts.bold,
    size: 27,
    color: accent,
    x: 72,
    y: 66,
    lineHeight: 30,
  });
  current = appendTextLines(filters, {
    input: current,
    output: 'hook',
    paths: textPaths.hook,
    fontPath: fonts.bold,
    size: template.hook_font_size,
    color: 'white',
    x: 72,
    y: 126,
    lineHeight: template.hook_font_size + 8,
  });
  current = appendTextLines(filters, {
    input: current,
    output: 'deck',
    paths: textPaths.deck,
    fontPath: fonts.regular,
    size: 28,
    color: 'white@0.72',
    x: 72,
    y: 296,
    lineHeight: 34,
  });
  filters.push(
    `[${current}]drawbox=x=72:y=1580:w=936:h=104:color=${accent}@0.96:t=fill[cta_box]`,
  );
  current = appendTextLines(filters, {
    input: 'cta_box',
    output: 'cta',
    paths: textPaths.cta,
    fontPath: fonts.bold,
    size: template.cta_font_size,
    color: 'black',
    x: 102,
    y: 1602,
    lineHeight: template.cta_font_size + 4,
  });
  current = appendTextLines(filters, {
    input: current,
    output: 'disclosure',
    paths: textPaths.disclosure,
    fontPath: fonts.regular,
    size: template.disclosure_font_size,
    color: 'white@0.64',
    x: 72,
    y: 1722,
    lineHeight: template.disclosure_font_size + 4,
  });
  current = appendTextLines(filters, {
    input: current,
    output: 'identity',
    paths: textPaths.identity,
    fontPath: fonts.regular,
    size: 19,
    color: 'white@0.34',
    x: 72,
    y: 1842,
    lineHeight: 22,
  });
  filters.push(
    `[${current}]fade=t=in:st=0:d=0.35,fade=t=out:st=${(
      pack.output.duration_ms / 1000 - 0.35
    ).toFixed(3)}:d=0.35,scale=in_range=auto:out_range=tv,format=yuv420p[outv]`,
  );
  return filters.join(';');
}

function renderRecipe(pack, artifact, source, renderEnvironment) {
  return {
    schema_version: PACK_SCHEMA,
    batch_id: pack.batch_id,
    template: pack.template,
    output: pack.output,
    renderer: renderEnvironment,
    source,
    artifact,
  };
}

async function resolveRenderEnvironment(ffmpeg, fonts) {
  const [rendererSha256, boldFontSha256, regularFontSha256, ffmpegVersion] =
    await Promise.all([
      sha256File(RENDERER_SCRIPT_PATH),
      sha256File(fonts.bold),
      sha256File(fonts.regular),
      runCommand(ffmpeg, ['-version']),
    ]);
  return {
    profile_id: RENDERER_PROFILE_ID,
    renderer_sha256: rendererSha256,
    bold_font_sha256: boldFontSha256,
    regular_font_sha256: regularFontSha256,
    ffmpeg_build_sha256: sha256Text(
      ffmpegVersion.replaceAll('\r\n', '\n').trim(),
    ),
  };
}

export async function snapshotVerifiedSource({
  sourcePath,
  source,
  workDir,
}) {
  const stagedPath = join(
    workDir,
    `verified-source${extname(source.source_reference).toLowerCase()}`,
  );
  await copyFile(sourcePath, stagedPath);
  const digest = await sha256File(stagedPath);
  if (digest !== source.source_sha256) {
    await rm(stagedPath, { force: true });
    fail(`Source SHA-256 changed before rendering: ${source.source_reference}`);
  }
  return stagedPath;
}

async function probeOutput(path, ffprobe = 'ffprobe') {
  const stdout = await runCommand(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,color_space,color_transfer,color_primaries:format=format_name,duration,size',
    '-of',
    'json',
    path,
  ]);
  try {
    return JSON.parse(stdout);
  } catch {
    fail('ffprobe returned invalid JSON');
  }
}

function rational(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

async function moovPrecedesMdat(path) {
  const handle = await open(path, 'r');
  try {
    const file = await handle.stat();
    const length = Math.min(file.size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const moov = buffer.indexOf(Buffer.from('moov'));
    const mdat = buffer.indexOf(Buffer.from('mdat'));
    return moov >= 0 && mdat >= 0 && moov < mdat;
  } finally {
    await handle.close();
  }
}

export async function validateRenderedVideo(path, pack, ffprobe = 'ffprobe') {
  const probe = await probeOutput(path, ffprobe);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
  const bytes = Number(probe.format?.size || (await stat(path)).size);
  const fps = rational(video?.avg_frame_rate || video?.r_frame_rate);
  if (
    video?.codec_name !== 'h264'
    || Number(video?.width) !== pack.output.width
    || Number(video?.height) !== pack.output.height
    || video?.pix_fmt !== 'yuv420p'
    || Math.abs(fps - pack.output.fps) > 0.01
    || durationMs < pack.output.duration_ms - 100
    || durationMs > pack.output.duration_ms + 100
    || audio?.codec_name !== 'aac'
    || Number(audio?.sample_rate) !== 48000
    || Number(audio?.channels) !== 2
    || bytes < 1
    || bytes > MAX_OUTPUT_BYTES
    || !(await moovPrecedesMdat(path))
  ) {
    fail('Rendered video failed codec, dimension, duration, audio, size, or fast-start validation');
  }
  return {
    mime_type: 'video/mp4',
    width: Number(video.width),
    height: Number(video.height),
    duration_ms: durationMs,
    frame_rate: fps,
    video_codec: video.codec_name,
    pixel_format: video.pix_fmt,
    audio_codec: audio.codec_name,
    audio_sample_rate: Number(audio.sample_rate),
    audio_channels: Number(audio.channels),
    byte_size: bytes,
    color_space: video.color_space || 'bt709',
    color_transfer: video.color_transfer || 'bt709',
    color_primaries: video.color_primaries || 'bt709',
    fast_start: true,
  };
}

export function buildRenderedArtifactFields({
  artifact,
  technical,
  mediaUrl,
  mediaSha256,
  thumbnailOffsetMs,
}) {
  return {
    artifact_key: artifact.artifact_key,
    concept_id: artifact.concept_id,
    campaign: artifact.campaign,
    platform: artifact.platform,
    platform_content_id: artifact.platform_content_id,
    title: artifact.title,
    pillar: artifact.pillar,
    format: artifact.format,
    source_asset_keys: [artifact.source_asset_key],
    hook: artifact.hook,
    caption: artifact.caption,
    overlay_text: artifact.overlay_text,
    shot_list: artifact.shot_list,
    cta_label: artifact.cta_label,
    cta_url: artifact.cta_url,
    disclosure: artifact.disclosure,
    media_url: mediaUrl,
    media_sha256: mediaSha256,
    mime_type: technical.mime_type,
    width: technical.width,
    height: technical.height,
    duration_ms: technical.duration_ms,
    thumbnail_offset_ms: thumbnailOffsetMs,
    ai_generated: artifact.ai_generated === true,
  };
}

async function renderArtifact({
  pack,
  artifact,
  source,
  sourcePath,
  outputDir,
  mediaOrigin,
  ffmpeg,
  ffprobe,
  fonts,
  renderEnvironment,
}) {
  const effectivePack = {
    ...pack,
    output: {
      ...pack.output,
      duration_ms: artifact.render.duration_ms,
      thumbnail_offset_ms: Math.min(
        pack.output.thumbnail_offset_ms,
        artifact.render.duration_ms - 1,
      ),
    },
  };
  const workDir = join(outputDir, '.work', artifact.artifact_key);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const stagedSourcePath = await snapshotVerifiedSource({
    sourcePath,
    source,
    workDir,
  });
  const textPaths = await writeOverlayText(workDir, artifact, pack.template);
  const temporaryOutput = join(workDir, `${artifact.artifact_key}.rendering.mp4`);
  const durationSeconds = (effectivePack.output.duration_ms / 1000).toFixed(3);
  const filter = buildVideoFilter(effectivePack, artifact, source, textPaths, fonts);
  const sourceInputArgs = source.media_kind === 'image'
    ? [
      '-loop',
      '1',
      '-framerate',
      String(effectivePack.output.fps),
      '-t',
      durationSeconds,
      '-i',
      stagedSourcePath,
    ]
    : ['-i', stagedSourcePath];
  await runCommand(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...DETERMINISTIC_FFMPEG_GLOBAL_ARGS,
    ...sourceInputArgs,
    '-f',
    'lavfi',
    '-t',
    durationSeconds,
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex',
    filter,
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
    String(effectivePack.output.fps),
    '-fps_mode',
    'cfr',
    '-g',
    String(effectivePack.output.fps * 2),
    '-keyint_min',
    String(effectivePack.output.fps * 2),
    '-sc_threshold',
    '0',
    '-b:v',
    effectivePack.output.video_bitrate,
    '-maxrate',
    effectivePack.output.max_video_bitrate,
    '-bufsize',
    '16M',
    '-c:a',
    'aac',
    ...DETERMINISTIC_FFMPEG_CODEC_ARGS,
    '-b:a',
    effectivePack.output.audio_bitrate,
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
    '-movflags',
    '+faststart',
    '-shortest',
    '-t',
    durationSeconds,
    temporaryOutput,
  ], { sourceDir: dirname(sourcePath), outputDir });
  const technical = await validateRenderedVideo(temporaryOutput, effectivePack, ffprobe);
  const mediaSha256 = await sha256File(temporaryOutput);
  const deliveryKey = `sha256/${mediaSha256}-${artifact.artifact_key}.mp4`;
  const finalPath = join(outputDir, ...deliveryKey.split('/'));
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await access(finalPath);
    const existingHash = await sha256File(finalPath);
    if (existingHash !== mediaSha256) {
      fail(`The content-addressed output key already exists with different bytes for ${artifact.artifact_key}`);
    }
    await rm(temporaryOutput, { force: true });
  } catch (error) {
    if (error?.name === 'GrowthRenderError') throw error;
    await rename(temporaryOutput, finalPath);
  }
  await rm(workDir, { recursive: true, force: true });
  const recipe = renderRecipe(
    effectivePack,
    artifact,
    source,
    renderEnvironment,
  );
  const renderInputHash = sha256Text(canonicalStringify(recipe));
  const renderEnvironmentHash = sha256Text(
    canonicalStringify(renderEnvironment),
  );
  const mediaUrl = mediaOrigin ? `${mediaOrigin}/${deliveryKey}` : null;
  return {
    artifact_key: artifact.artifact_key,
    concept_id: artifact.concept_id,
    platform: artifact.platform,
    platform_content_id: artifact.platform_content_id,
    distribution_state: artifact.distribution_state,
    source_asset_keys: [artifact.source_asset_key],
    source_lineage: [{
      asset_key: source.asset_key,
      source_reference: source.source_reference,
      source_sha256: source.source_sha256,
    }],
    template_id: pack.template.id,
    template_version: pack.template.version,
    render_profile_id: renderEnvironment.profile_id,
    render_environment_sha256: renderEnvironmentHash,
    render_input_sha256: renderInputHash,
    delivery_key: deliveryKey,
    media_url: mediaUrl,
    media_sha256: mediaSha256,
    ...technical,
    thumbnail_offset_ms: effectivePack.output.thumbnail_offset_ms,
    qc: {
      source_sha256_verified: true,
      privacy_status: source.privacy_status,
      rights_status: source.rights_status,
      disclosure_burned_in: true,
      hook_first_frame: true,
      third_party_watermark: false,
      audio_mode: pack.output.audio_mode,
      ready_for_human_review: true,
      ready_for_content_engine_import:
        artifact.distribution_state === 'publish_candidate',
    },
    artifact_fields: buildRenderedArtifactFields({
      artifact,
      technical,
      mediaUrl,
      mediaSha256,
      thumbnailOffsetMs: effectivePack.output.thumbnail_offset_ms,
    }),
  };
}

async function verifySourceFiles(pack, sourceDir, repoDir) {
  const verified = new Map();
  for (const source of pack.sources) {
    const root = source.source_origin === 'repository_public'
      ? resolve(repoDir, 'public')
      : resolve(sourceDir);
    const path = resolve(root, source.source_reference);
    if (dirname(path) !== root) {
      fail(`${source.asset_key} escaped the configured source directory`);
    }
    try {
      await access(path);
    } catch {
      fail(`Missing audited source file: ${source.source_reference}`);
    }
    const file = await lstat(path);
    if (file.isSymbolicLink() || !file.isFile()) {
      fail(`Audited source must be a regular file: ${source.source_reference}`);
    }
    const digest = await sha256File(path);
    if (digest !== source.source_sha256) {
      fail(`Source SHA-256 mismatch: ${source.source_reference}`);
    }
    verified.set(source.asset_key, path);
  }
  return verified;
}

export async function renderPack({
  manifestPath = DEFAULT_MANIFEST,
  sourceDir,
  repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  outputDir,
  mediaOrigin = '',
  only = [],
  validateOnly = false,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
} = {}) {
  if (!sourceDir) fail('--source-dir is required');
  if (!outputDir) fail('--output-dir is required');
  const raw = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  const pack = validatePack(raw);
  const normalizedOrigin = normalizeMediaOrigin(mediaOrigin);
  const selected = only.length
    ? pack.artifacts.filter((artifact) => only.includes(artifact.artifact_key))
    : pack.artifacts;
  if (!selected.length) fail('--only did not match any artifact key');
  if (only.length && selected.length !== new Set(only).size) {
    fail('--only contains an unknown or duplicate artifact key');
  }
  const sourcePaths = await verifySourceFiles(
    pack,
    resolve(sourceDir),
    resolve(repoDir),
  );
  if (validateOnly) {
    return {
      schema_version: RESULT_SCHEMA,
      batch_id: pack.batch_id,
      status: 'validated',
      source_count: pack.sources.length,
      artifact_count: selected.length,
      media_origin: normalizedOrigin || null,
    };
  }
  await mkdir(resolve(outputDir), { recursive: true });
  const fonts = await resolveFonts();
  const renderEnvironment = await resolveRenderEnvironment(ffmpeg, fonts);
  const sourceByKey = new Map(pack.sources.map((source) => [source.asset_key, source]));
  const results = [];
  for (const artifact of selected) {
    const source = sourceByKey.get(artifact.source_asset_key);
    const result = await renderArtifact({
      pack,
      artifact,
      source,
      sourcePath: sourcePaths.get(source.asset_key),
      outputDir: resolve(outputDir),
      mediaOrigin: normalizedOrigin,
      ffmpeg,
      ffprobe,
      fonts,
      renderEnvironment,
    });
    results.push(result);
  }
  const manifest = {
    schema_version: RESULT_SCHEMA,
    batch_id: pack.batch_id,
    pack_sha256: sha256Text(canonicalStringify(pack)),
    pack,
    template: {
      id: pack.template.id,
      version: pack.template.version,
    },
    renderer: {
      ...renderEnvironment,
      environment_sha256: sha256Text(canonicalStringify(renderEnvironment)),
    },
    media_origin: normalizedOrigin || null,
    artifact_count: results.length,
    artifacts: results,
  };
  const resultPath = join(resolve(outputDir), `${pack.batch_id}.render-result.json`);
  await writeFile(resultPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function parseArgs(argv) {
  const result = {
    manifestPath: DEFAULT_MANIFEST,
    sourceDir: process.env.FIRSTKNOCK_ASSET_DIR || '',
    repoDir: process.env.FIRSTKNOCK_REPO_DIR
      || resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    outputDir: process.env.FIRSTKNOCK_RENDER_OUTPUT || '',
    mediaOrigin: process.env.GROWTH_MEDIA_ORIGIN || '',
    only: [],
    validateOnly: false,
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--validate-only') {
      result.validateOnly = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`${value} requires a value`);
    if (value === '--manifest') result.manifestPath = next;
    else if (value === '--source-dir') result.sourceDir = next;
    else if (value === '--repo-dir') result.repoDir = next;
    else if (value === '--output-dir') result.outputDir = next;
    else if (value === '--media-origin') result.mediaOrigin = next;
    else if (value === '--only') result.only.push(...next.split(',').filter(Boolean));
    else if (value === '--ffmpeg') result.ffmpeg = next;
    else if (value === '--ffprobe') result.ffprobe = next;
    else fail(`Unknown argument: ${value}`);
    index += 1;
  }
  if (!result.outputDir) {
    result.outputDir = resolve(process.cwd(), 'outputs', 'growth-media', 'latest');
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await renderPack(options);
  process.stdout.write(`${JSON.stringify({
    status: result.status || 'rendered',
    batch_id: result.batch_id,
    source_count: result.source_count,
    artifact_count: result.artifact_count,
    media_origin: result.media_origin,
  }, null, 2)}\n`);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
