#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from '../contract.mjs';
import { buildOvertureCanvasRegion, partitionNormalizedCanvasTile } from './adapter.mjs';
import { applyMarylandHomeDataAdapter } from './maryland-homedata-adapter.mjs';

const valueOptions = new Set(['--addresses', '--buildings', '--places', '--roads', '--osm', '--nad', '--assessors', '--property-polygon', '--homedata', '--homedata-version', '--homedata-observed-at', '--homedata-source-hash', '--osm-version', '--osm-observed-at', '--region', '--release-version', '--observed-at', '--generated-at', '--tile-count', '--output']);
function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!valueOptions.has(key) || !argv[index + 1]) throw new TypeError(`Unknown or incomplete argument: ${key}`);
    result[key.slice(2).replaceAll('-', '_')] = argv[++index];
  }
  for (const required of ['addresses', 'buildings', 'places', 'roads', 'region', 'release_version', 'observed_at', 'output']) if (!result[required]) throw new TypeError(`--${required.replaceAll('_', '-')} is required.`);
  return result;
}

async function json(path) { return JSON.parse(await readFile(resolve(path), 'utf8')); }

export async function runOvertureRegionBuild(argv = process.argv.slice(2)) {
  const options = args(argv);
  const result = buildOvertureCanvasRegion({
    addresses: await json(options.addresses), buildings: await json(options.buildings), places: await json(options.places), roads: await json(options.roads),
    osm: options.osm ? await json(options.osm) : null, nad: options.nad ? await json(options.nad) : null, assessors: options.assessors ? await json(options.assessors) : null,
    propertyPolygon: options.property_polygon ? await json(options.property_polygon) : null,
    osmSource: options.osm_version ? { source_id: 'openstreetmap', dataset_version: options.osm_version, captured_at: new Date(options.osm_observed_at || options.observed_at).toISOString(), license: 'ODbL-1.0' } : null,
    regionKey: options.region, releaseVersion: options.release_version, observedAt: new Date(options.observed_at).toISOString(),
  });
  const homeData = options.homedata ? applyMarylandHomeDataAdapter({
    rows: await json(options.homedata), polygon: await json(options.property_polygon), sourceTile: result.source_tile, normalizedTiles: [result.normalized_tile],
    datasetVersion: options.homedata_version, observedAt: new Date(options.homedata_observed_at || options.observed_at).toISOString(), expectedSourceHash: options.homedata_source_hash,
  }) : null;
  const sourceTile = homeData?.source_tile || result.source_tile;
  const normalizedTile = homeData?.normalized_tile || result.normalized_tile;
  const normalizedTiles = partitionNormalizedCanvasTile(normalizedTile, Number(options.tile_count || 1));
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const generatedAt = new Date(options.generated_at || Date.now()).toISOString();
  const release = {
    schema: 'firstknock.canvas-normalized-evidence-release', schema_version: 1,
    release: { dataset_namespace: 'firstknock-overture-properties', dataset_version: `${options.release_version}.${options.region}`, generated_at: generatedAt },
    coverage: { country_codes: ['US'], bounds: normalizedTiles.reduce((bounds, tile) => ({ min_lng: Math.min(bounds.min_lng, tile.coverage.bounds.min_lng), min_lat: Math.min(bounds.min_lat, tile.coverage.bounds.min_lat), max_lng: Math.max(bounds.max_lng, tile.coverage.bounds.max_lng), max_lat: Math.max(bounds.max_lat, tile.coverage.bounds.max_lat) }), { min_lng: Infinity, min_lat: Infinity, max_lng: -Infinity, max_lat: -Infinity }) },
    tile_scheme: { scheme: 'firstknock-regional-grid', scheme_version: 1 }, sources: [...result.sources, ...(homeData ? [homeData.source] : [])].sort((left, right) => left.source_id.localeCompare(right.source_id)),
    tile_inputs: ['normalized.ndjson'],
  };
  await Promise.all([
    writeFile(join(output, 'source.json'), canonicalStringify(sourceTile)),
    writeFile(join(output, 'normalized.ndjson'), `${normalizedTiles.map((tile) => canonicalStringify(tile)).join('\n')}\n`),
    writeFile(join(output, 'release.json'), canonicalStringify(release)),
    writeFile(join(output, 'etl-report.json'), canonicalStringify({ ...result.report, ...(homeData ? { homedata: homeData.report } : {}), unlinked_properties: result.unlinked_properties })),
    ...(homeData ? [writeFile(join(output, 'homedata-evidence-ledger.ndjson'), `${homeData.evidence_ledger.map((item) => canonicalStringify(item)).join('\n')}\n`)] : []),
  ]);
  return { ...result.report, ...(homeData ? { homedata: homeData.report } : {}), normalized_tile_count: normalizedTiles.length, output_directory: output };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runOvertureRegionBuild().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`Canvas Overture ETL failed: ${error.message}\n`); process.exitCode = 1; });