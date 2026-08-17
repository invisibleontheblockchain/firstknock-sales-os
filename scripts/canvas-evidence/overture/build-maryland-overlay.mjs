#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from '../contract.mjs';
import { buildMarylandPropertyOverlay } from './maryland-overlay.mjs';

const optionsWithValues = new Set(['--base-release', '--base-tiles', '--addresses', '--buildings', '--places', '--osm', '--region', '--release-version', '--observed-at', '--generated-at', '--output']);
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!optionsWithValues.has(option) || !argv[index + 1]) throw new TypeError(`Unknown or incomplete argument: ${option}`);
    result[option.slice(2).replaceAll('-', '_')] = argv[++index];
  }
  for (const required of ['base_release', 'base_tiles', 'addresses', 'buildings', 'places', 'region', 'release_version', 'observed_at', 'output']) {
    if (!result[required]) throw new TypeError(`--${required.replaceAll('_', '-')} is required.`);
  }
  return result;
}

async function json(path) { return JSON.parse(await readFile(resolve(path), 'utf8')); }
async function tiles(path) {
  const text = await readFile(resolve(path), 'utf8');
  if (path.endsWith('.ndjson') || path.endsWith('.jsonl')) return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function runMarylandPropertyOverlay(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const baseRelease = await json(options.base_release);
  const osmSource = (baseRelease.sources || []).find((source) => source.source_id === 'openstreetmap' || /openstreetmap/i.test(source.provider || '')) || null;
  const result = buildMarylandPropertyOverlay({
    baseTiles: await tiles(options.base_tiles), addresses: await json(options.addresses), buildings: await json(options.buildings), places: await json(options.places),
    osm: options.osm ? await json(options.osm) : null, osmSource,
    releaseVersion: options.release_version, observedAt: new Date(options.observed_at).toISOString(),
  });
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const generatedAt = new Date(options.generated_at || Date.now()).toISOString();
  const bounds = result.normalized_tiles.reduce((value, tile) => ({
    min_lng: Math.min(value.min_lng, tile.coverage.bounds.min_lng), min_lat: Math.min(value.min_lat, tile.coverage.bounds.min_lat),
    max_lng: Math.max(value.max_lng, tile.coverage.bounds.max_lng), max_lat: Math.max(value.max_lat, tile.coverage.bounds.max_lat),
  }), { min_lng: Infinity, min_lat: Infinity, max_lng: -Infinity, max_lat: -Infinity });
  const overtureSources = [
    ['overture-addresses', 'Overture Maps Addresses'], ['overture-buildings', 'Overture Maps Buildings'], ['overture-places', 'Overture Maps Places'],
  ].map(([source_id, provider]) => ({ source_id, provider, dataset_version: options.release_version, license: 'ODbL-1.0', captured_at: new Date(options.observed_at).toISOString() }));
  const release = {
    schema: 'firstknock.canvas-normalized-evidence-release', schema_version: 1,
    release: { dataset_namespace: 'firstknock-maryland-properties', dataset_version: `${options.release_version}.${options.region}`, generated_at: generatedAt },
    coverage: { country_codes: baseRelease.coverage?.country_codes || ['US'], bounds },
    tile_scheme: baseRelease.tile_scheme,
    sources: [...(baseRelease.sources || []), ...overtureSources].sort((left, right) => left.source_id.localeCompare(right.source_id)),
    tile_inputs: ['normalized.ndjson'],
  };
  await Promise.all([
    writeFile(join(output, 'normalized.ndjson'), `${result.normalized_tiles.map((tile) => canonicalStringify(tile)).join('\n')}\n`),
    writeFile(join(output, 'release.json'), canonicalStringify(release)),
    writeFile(join(output, 'ab-report.json'), canonicalStringify({ region_key: options.region, ...result.report, unlinked_properties: result.unlinked_properties })),
  ]);
  return { ...result.report, output_directory: output };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runMarylandPropertyOverlay().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`Canvas Maryland property overlay failed: ${error.message}\n`); process.exitCode = 1; });