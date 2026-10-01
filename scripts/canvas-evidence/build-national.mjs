#!/usr/bin/env node
// National Canvas evidence build: pinned Geofabrik extracts -> per-region releases.
//
//   for each region:  .osm.pbf -> source evidence -> normalized -> signed release -> R2
//   finally:          national index mapping geography -> region release
//
// One release per region, never a combined one. Regions overlap at their
// borders by design — Geofabrik ships complete ways across its own boundaries,
// so the same blockface can appear in two neighbouring extracts. Measured on
// two independent seams (DC/Maryland 993 shared units, norcal/socal 445), every
// shared unit was byte-identical, so the overlap is duplication rather than
// disagreement. Keeping releases separate means the release builder's
// duplicate_release_work_unit check stays a strict invariant inside a release
// instead of being weakened to tolerate cross-region overlap.
//
// Region boundaries come from Geofabrik's own .poly files. Hand-drawn boxes are
// specifically what this pipeline must not use: a box that cuts a way leaves
// each side computing a different midpoint for the same identity, which is how
// the same work unit ended up in two cells with conflicting geometry.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEOFABRIK = 'https://download.geofabrik.de/north-america/us';

const USAGE = `Build Canvas evidence releases for every US region.

Usage:
  node scripts/canvas-evidence/build-national.mjs \\
    --work-dir <scratch directory> \\
    [--regions maryland,delaware]   default: every region in regions.json
    [--stage compile|normalize|release|upload|index]  stop after this stage
    [--bucket <r2-bucket> --endpoint <r2-endpoint>]   required to upload
    [--keep-intermediates]                            default: delete after release
    [--max-old-space-size 24576]

Resumable: a stage whose output already exists is skipped, so an interrupted
run continues where it stopped. Credentials come from the environment only:
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CANVAS_EVIDENCE_SIGNING_KEY
`;

function fail(message) {
  process.stderr.write(`build-national: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const result = { stage: 'index', keepIntermediates: false, maxOldSpace: '24576' };
  const keys = new Map([
    ['--work-dir', 'workDir'], ['--regions', 'regions'], ['--stage', 'stage'],
    ['--bucket', 'bucket'], ['--endpoint', 'endpoint'], ['--max-old-space-size', 'maxOldSpace'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') return { help: true };
    if (argv[index] === '--keep-intermediates') { result.keepIntermediates = true; continue; }
    const key = keys.get(argv[index]);
    if (!key) fail(`Unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined) fail(`${argv[index]} requires a value`);
    result[key] = value;
    index += 1;
  }
  if (!result.workDir) fail('--work-dir is required');
  return result;
}

const exists = (path) => stat(path).then(() => true, () => false);

function run(command, args, { cwd } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', rejectPromise);
    child.on('close', (code) => (code === 0
      ? resolvePromise({ stdout, stderr })
      : rejectPromise(new Error(`${command} ${args.join(' ')} exited ${code}`))));
  });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function md5File(path) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * Region extent from Geofabrik's own .poly file.
 *
 * The adapter's quadtree uses this as its root box, and depth is relative to
 * it — the same depth over a state reaches ~2 km cells where over a county it
 * reaches ~200 m. Deriving the box from the region's real extent keeps tiles
 * sized to the data rather than to whatever box a human typed.
 */
function boundsFromPoly(text) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  // A hair of padding so a boundary node is never excluded by rounding.
  return {
    min_lng: minLng - 0.001, min_lat: minLat - 0.001,
    max_lng: maxLng + 0.001, max_lat: maxLat + 0.001,
  };
}

async function fetchRegion(region, workDir) {
  const pbfPath = join(workDir, `${region.slug}.osm.pbf`);
  const polyPath = join(workDir, `${region.slug}.poly`);
  const base = `${GEOFABRIK}/${region.path}`;

  if (!await exists(polyPath)) await download(`${base}.poly`, polyPath);
  const bounds = boundsFromPoly(await readFile(polyPath, 'utf8'));
  if (!bounds) throw new Error(`${region.slug}: could not derive bounds from .poly`);

  const expectedMd5 = (await (await fetch(`${base}-latest.osm.pbf.md5`)).text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{32}$/.test(expectedMd5)) throw new Error(`${region.slug}: no usable md5 published`);

  if (await exists(pbfPath) && await md5File(pbfPath) === expectedMd5) {
    process.stdout.write(`  [${region.slug}] extract already present and verified\n`);
  } else {
    process.stdout.write(`  [${region.slug}] downloading extract\n`);
    await download(`${base}-latest.osm.pbf`, pbfPath);
    const actual = await md5File(pbfPath);
    if (actual !== expectedMd5) {
      // A silently corrupt extract would produce a signed release built on
      // wrong data, which is worse than no release at all.
      throw new Error(`${region.slug}: md5 mismatch (published ${expectedMd5}, got ${actual})`);
    }
  }
  // The md5 pins the dataset: two runs of the same version produce the same
  // identities, and a release can always be traced back to the exact bytes.
  return { pbfPath, bounds, datasetVersion: `${region.slug}.${expectedMd5.slice(0, 8)}` };
}

async function compileRegion(region, context) {
  const output = join(context.workDir, `${region.slug}.source.ndjson`);
  if (await exists(output)) { process.stdout.write(`  [${region.slug}] compile: cached\n`); return output; }
  const { bounds, pbfPath, datasetVersion } = context.fetched;
  await run(process.execPath, [
    `--max-old-space-size=${context.maxOldSpace}`,
    join(HERE, 'osm-source-adapter.mjs'),
    '--pbf', pbfPath,
    '--bbox', `${bounds.min_lng},${bounds.min_lat},${bounds.max_lng},${bounds.max_lat}`,
    '--tile-key', `us-${region.slug}`,
    '--source-id', `geofabrik-${region.slug}`,
    '--dataset-version', datasetVersion,
    '--license', 'ODbL-1.0',
    '--observed-at', context.observedAt,
    '--output', output,
  ]);
  return output;
}

async function inputParts(sourcePath) {
  const directory = dirname(sourcePath);
  const base = sourcePath.slice(directory.length + 1).replace(/\.ndjson$/, '');
  const entries = await readdir(directory);
  return entries
    .filter((name) => name === `${base}.ndjson` || name.startsWith(`${base}.part`))
    .sort()
    .map((name) => join(directory, name));
}

async function normalizeRegion(region, context, sourcePath) {
  const output = join(context.workDir, `${region.slug}.normalized.ndjson`);
  if (await exists(output)) { process.stdout.write(`  [${region.slug}] normalize: cached\n`); return output; }
  const args = [`--max-old-space-size=${context.maxOldSpace}`, join(HERE, 'normalize-source.mjs')];
  for (const part of await inputParts(sourcePath)) args.push('--input', part);
  args.push('--output', output);
  await run(process.execPath, args);
  return output;
}

async function releaseRegion(region, context, normalizedPath) {
  const outDir = join(context.workDir, `${region.slug}.release`);
  if (await exists(outDir)) {
    const [existing] = (await readdir(outDir)).filter((name) => name.startsWith('cer1_'));
    if (existing) { process.stdout.write(`  [${region.slug}] release: cached\n`); return join(outDir, existing); }
  }
  if (!process.env.CANVAS_EVIDENCE_SIGNING_PRIVATE_KEY_FILE || !process.env.CANVAS_EVIDENCE_SIGNING_KEY_ID) {
    throw new Error('CANVAS_EVIDENCE_SIGNING_PRIVATE_KEY_FILE and CANVAS_EVIDENCE_SIGNING_KEY_ID must be set to build releases');
  }
  await mkdir(outDir, { recursive: true });

  // Coverage is the union of the tiles actually emitted, read from the adapter's
  // summary. The region's .poly extent would be wrong here: complete ways carry
  // geometry past the border, so real tiles reach outside the polygon.
  const summary = JSON.parse(await readFile(`${context.sourcePath}.summary.json`, 'utf8'));
  const descriptorPath = join(context.workDir, `${region.slug}.release.json`);
  await writeFile(descriptorPath, `${JSON.stringify({
    schema: 'firstknock.canvas-normalized-evidence-release',
    schema_version: 1,
    release: {
      dataset_namespace: 'firstknock-us-residential',
      dataset_version: `${context.observedAt.slice(0, 10)}.${region.slug}.1`,
      generated_at: context.observedAt,
    },
    coverage: { country_codes: ['US'], bounds: summary.coverage_bounds },
    tile_scheme: { scheme: 'osm-bbox', scheme_version: 1 },
    sources: [{
      source_id: `geofabrik-${region.slug}`,
      provider: 'Geofabrik GmbH / OpenStreetMap contributors',
      dataset_version: context.fetched.datasetVersion,
      license: 'ODbL-1.0',
      captured_at: context.observedAt,
    }],
  }, null, 2)}\n`, 'utf8');

  // The signing key is read by the child from the environment and never passed
  // as an argument, so it cannot land in a process listing or a shell history.
  await run(process.execPath, [
    `--max-old-space-size=${context.maxOldSpace}`,
    join(HERE, 'build-release.mjs'),
    '--release', descriptorPath,
    '--input', normalizedPath,
    '--output', outDir,
  ]);
  const [built] = (await readdir(outDir)).filter((name) => name.startsWith('cer1_'));
  if (!built) throw new Error(`${region.slug}: release builder produced no cer1_ directory`);
  return join(outDir, built);
}

async function uploadRegion(region, context, releaseDir) {
  if (!context.bucket || !context.endpoint) {
    process.stdout.write(`  [${region.slug}] upload: skipped (no --bucket/--endpoint)\n`);
    return null;
  }
  await run(process.execPath, [
    join(HERE, 'publish-release.mjs'),
    '--release-dir', releaseDir,
    '--bucket', context.bucket,
    '--endpoint', context.endpoint,
    '--resume',
  ]);
  const inventory = JSON.parse(await readFile(join(releaseDir, 'upload-inventory.json'), 'utf8'));
  return inventory.object_prefix;
}

// V8 reports heap exhaustion several ways depending on where it ran out, and a
// swap-thrashed process is usually killed by the OS instead. All of them mean
// the same thing here: this extract does not fit, try it in smaller pieces.
function isMemoryFailure(message) {
  return /heap out of memory|heap limit|Allocation failed|Map maximum size|Array buffer allocation failed|exited (134|137|3221225725)/i.test(String(message));
}

const STAGES = ['compile', 'normalize', 'release', 'upload', 'index'];

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }
  if (!STAGES.includes(options.stage)) fail(`--stage must be one of ${STAGES.join(', ')}`);

  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });

  const catalog = JSON.parse(await readFile(join(HERE, 'regions.json'), 'utf8'));
  const wanted = options.regions ? new Set(options.regions.split(',').map((value) => value.trim())) : null;
  const regions = catalog.regions.filter((region) => !wanted || wanted.has(region.slug));
  if (!regions.length) fail('No regions selected.');

  const stageIndex = STAGES.indexOf(options.stage);
  const observedAt = new Date().toISOString();
  const index = [];
  const failures = [];

  process.stdout.write(`Building ${regions.length} region(s) through stage "${options.stage}".\n\n`);

  const pending = [...regions];
  for (let position = 0; position < pending.length; position += 1) {
    const region = pending[position];
    const label = `${position + 1}/${pending.length} ${region.slug}`;
    process.stdout.write(`[${label}] start\n`);
    const started = Date.now();
    try {
      const fetched = await fetchRegion(region, workDir);
      const context = {
        workDir, observedAt, fetched,
        maxOldSpace: options.maxOldSpace,
        bucket: options.bucket,
        endpoint: options.endpoint,
      };

      const sourcePath = await compileRegion(region, context);
      context.sourcePath = sourcePath;
      let normalizedPath = null;
      let releaseDir = null;
      let objectPrefix = null;

      if (stageIndex >= STAGES.indexOf('normalize')) normalizedPath = await normalizeRegion(region, context, sourcePath);
      if (stageIndex >= STAGES.indexOf('release') && normalizedPath) releaseDir = await releaseRegion(region, context, normalizedPath);
      if (stageIndex >= STAGES.indexOf('upload') && releaseDir) objectPrefix = await uploadRegion(region, context, releaseDir);

      if (releaseDir) {
        const inventory = JSON.parse(await readFile(join(releaseDir, 'upload-inventory.json'), 'utf8'));
        index.push({
          region_id: region.slug,
          region_name: region.name,
          bounds: fetched.bounds,
          dataset_version: fetched.datasetVersion,
          release_id: inventory.release_id,
          object_prefix: objectPrefix || inventory.object_prefix,
          manifest_sha256: await sha256File(join(releaseDir, 'manifest.json')),
        });
      }

      // Intermediates dwarf the release itself; a national run keeps only what
      // the next stage needs unless asked to keep everything.
      if (!options.keepIntermediates && releaseDir) {
        for (const part of await inputParts(sourcePath)) await rm(part, { force: true });
        if (normalizedPath) await rm(normalizedPath, { force: true });
      }
      process.stdout.write(`[${label}] done in ${Math.round((Date.now() - started) / 1000)}s\n\n`);
    } catch (error) {
      const message = error?.message || String(error);
      // Running out of memory is the one failure with a known, proven remedy:
      // compile the region's own Geofabrik sub-regions instead. Their seams
      // were measured to be exactly as clean as state seams (445 of 445 shared
      // units byte-identical), so this splits the work without splitting a way.
      // Any hand-drawn subdivision would not be safe and is never attempted.
      if (isMemoryFailure(message) && region.sub_regions?.length && !region.isSubRegion) {
        process.stderr.write(`[${label}] out of memory; retrying as ${region.sub_regions.length} sub-regions\n`);
        pending.splice(position + 1, 0, ...region.sub_regions.map((sub) => ({ ...sub, isSubRegion: true })));
        failures.push({ region: region.slug, message: `split into sub-regions after: ${message}`, recovered: true });
        continue;
      }
      // One bad region must not abandon the other fifty: record it, keep going,
      // and exit non-zero at the end so a partial run is never mistaken for a
      // complete one.
      failures.push({ region: region.slug, message });
      process.stderr.write(`[${label}] FAILED: ${message}\n\n`);
    }
  }

  if (stageIndex >= STAGES.indexOf('index') && index.length) {
    const indexPath = join(workDir, 'national-index.json');
    await writeFile(indexPath, `${JSON.stringify({
      schema: 'firstknock.canvas-national-index',
      schema_version: 1,
      generated_at: observedAt,
      region_count: index.length,
      regions: index.sort((left, right) => left.region_id.localeCompare(right.region_id)),
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(`National index: ${indexPath} (${index.length} regions)\n`);
  }

  process.stdout.write(`\nComplete: ${index.length} region(s) built, ${failures.length} failed.\n`);
  for (const failure of failures) process.stdout.write(`  FAILED ${failure.region}: ${failure.message}\n`);
  if (failures.length) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => fail(error?.message || String(error)));

export { boundsFromPoly, inputParts };
