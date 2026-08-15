#!/usr/bin/env node

import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from './contract.mjs';
import {
  CANVAS_SOURCE_EVIDENCE_SCHEMA,
  CanvasSourceNormalizationError,
  DEFAULT_MAX_NEAREST_ROAD_METERS,
  normalizeCanvasSourceEvidenceTiles,
} from './source-normalizer.mjs';

const COLLECTION_SCHEMA = 'firstknock.canvas-source-evidence-collection';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
const INPUT_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson']);

const USAGE = `Normalize provider-neutral Canvas source evidence into release-builder input.

Usage:
  node scripts/canvas-evidence/normalize-source.mjs \\
    --input <source-tile-file-or-directory> [--input ...] \\
    --output <normalized-tiles.ndjson> \\
    [--max-nearest-road-meters 60]

Validation without writing:
  node scripts/canvas-evidence/normalize-source.mjs \\
    --input <source-tiles> --validate-only

Inputs are strict source-evidence v1 JSON tiles, a versioned JSON collection, or
NDJSON with one source-evidence v1 tile per nonblank line. Existing outputs are
never overwritten.
`;

function fail(code, message, details = {}) {
  throw new CanvasSourceNormalizationError(code, message, details);
}

function parseArguments(argv) {
  const result = { input: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--validate-only') {
      result.validateOnly = true;
      continue;
    }
    if (!['--input', '--output', '--max-nearest-road-meters'].includes(argument)) {
      fail('unknown_argument', `Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('missing_argument_value', `${argument} requires a value.`);
    index += 1;
    if (argument === '--input') result.input.push(value);
    else if (argument === '--output') result.output = value;
    else result.maxNearestRoadMeters = value;
  }
  return result;
}

async function collectFiles(inputPaths) {
  const files = [];
  const visit = async (path) => {
    const details = await lstat(path);
    if (details.isSymbolicLink()) fail('source_symlink_forbidden', `Source evidence cannot be read through a symbolic link: ${path}`, { path });
    if (details.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) fail('source_symlink_forbidden', `Source evidence cannot contain symbolic links: ${resolve(path, entry.name)}`);
        if (entry.isDirectory()) await visit(resolve(path, entry.name));
        else if (entry.isFile() && INPUT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(resolve(path, entry.name));
      }
      return;
    }
    if (!details.isFile() || !INPUT_EXTENSIONS.has(extname(path).toLowerCase())) {
      fail('invalid_source_input', `Source input must be a JSON, JSONL, or NDJSON regular file: ${path}`, { path });
    }
    files.push(path);
  };
  for (const path of inputPaths.map((value) => resolve(value)).sort()) await visit(path);
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) fail('missing_source_inputs', 'No source evidence files were found.');
  return unique;
}

function extractJsonTiles(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_source_json', `${path} must contain a source-evidence tile or a versioned collection.`, { path });
  }
  if (value.schema === CANVAS_SOURCE_EVIDENCE_SCHEMA.tile) return [value];
  if (value.schema !== COLLECTION_SCHEMA || value.schema_version !== 1) {
    fail('unsupported_source_collection', `${path} does not use a supported source-evidence schema.`, { path });
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !['schema', 'schema_version', 'tiles'].includes(key)) || !Array.isArray(value.tiles) || value.tiles.length === 0) {
    fail('invalid_source_collection', `${path} must contain only schema, schema_version, and a non-empty tiles array.`, { path });
  }
  return value.tiles;
}

async function readSourceFile(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') {
    const details = await lstat(path);
    if (details.size > MAX_JSON_BYTES) {
      fail('source_json_too_large', `JSON source input exceeds ${MAX_JSON_BYTES} bytes; use NDJSON.`, { path });
    }
    try {
      return extractJsonTiles(JSON.parse(await readFile(path, 'utf8')), path);
    } catch (error) {
      if (error instanceof CanvasSourceNormalizationError) throw error;
      fail('invalid_source_json', `Invalid JSON in ${path}: ${error.message}`, { path });
    }
  }
  const tiles = [];
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) {
      fail('source_ndjson_line_too_large', `NDJSON line ${lineNumber} in ${path} exceeds the safety limit.`, { path, line: lineNumber });
    }
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== CANVAS_SOURCE_EVIDENCE_SCHEMA.tile) {
        fail('invalid_source_ndjson_record', `${path}:${lineNumber} must contain exactly one source-evidence v1 tile.`, { path, line: lineNumber });
      }
      tiles.push(value);
    } catch (error) {
      if (error instanceof CanvasSourceNormalizationError) throw error;
      fail('invalid_source_json', `Invalid JSON in ${path} at line ${lineNumber}: ${error.message}`, { path, line: lineNumber });
    }
  }
  return tiles;
}

async function atomicWriteNew(path, bytes) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  try {
    await lstat(output);
    fail('output_already_exists', `Refusing to overwrite existing normalized evidence: ${output}`, { path: output });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = resolve(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, output);
    } catch (error) {
      if (error?.code === 'EEXIST') fail('output_already_exists', `Refusing to overwrite existing normalized evidence: ${output}`, { path: output });
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
  return output;
}

export async function runCanvasSourceNormalizerCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) return { help: true };
  if (options.input.length === 0) fail('missing_source_inputs', 'At least one --input is required.');
  if (!options.validateOnly && !options.output) fail('missing_normalized_output', '--output is required unless --validate-only is used.');
  if (options.validateOnly && options.output) fail('invalid_normalization_mode', '--output cannot be used with --validate-only.');
  const maxNearestRoadMeters = options.maxNearestRoadMeters === undefined
    ? DEFAULT_MAX_NEAREST_ROAD_METERS
    : Number(options.maxNearestRoadMeters);
  if (!Number.isFinite(maxNearestRoadMeters)) fail('invalid_nearest_road_limit', '--max-nearest-road-meters must be a number.');
  const files = await collectFiles(options.input);
  const rawTiles = [];
  for (const path of files) rawTiles.push(...await readSourceFile(path));
  if (rawTiles.length === 0) fail('missing_source_tiles', 'Source evidence files did not contain any tiles.');
  const tiles = normalizeCanvasSourceEvidenceTiles(rawTiles, { maxNearestRoadMeters });
  const roleCounts = { opportunity: 0, transit: 0, excluded: 0, uncertain: 0 };
  for (const tile of tiles) {
    for (const unit of tile.work_units) roleCounts[unit.canvas_role] += 1;
  }
  let outputPath = null;
  if (!options.validateOnly) {
    const bytes = `${tiles.map((tile) => canonicalStringify(tile)).join('\n')}\n`;
    outputPath = await atomicWriteNew(options.output, bytes);
  }
  return Object.freeze({
    mode: options.validateOnly ? 'validate-only' : 'normalize',
    input_file_count: files.length,
    tile_count: tiles.length,
    work_unit_count: Object.values(roleCounts).reduce((sum, count) => sum + count, 0),
    role_counts: roleCounts,
    output_path: outputPath,
    max_nearest_road_meters: maxNearestRoadMeters,
    tiles,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await runCanvasSourceNormalizerCli();
    if (result.help) process.stdout.write(USAGE);
    else {
      process.stdout.write(`Canvas source evidence ${result.mode === 'validate-only' ? 'valid' : 'normalized'}: ${result.tile_count} tiles, ${result.work_unit_count} work units.\n`);
      process.stdout.write(`Roles: ${JSON.stringify(result.role_counts)}\n`);
      if (result.output_path) process.stdout.write(`Output: ${result.output_path}\n`);
    }
  } catch (error) {
    process.stderr.write(`Canvas source normalization failed [${error?.code || 'unexpected_error'}]: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
