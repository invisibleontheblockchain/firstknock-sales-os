#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from '../contract.mjs';
import { buildOvertureCanvasRegion } from './adapter.mjs';

const valueOptions = new Set(['--addresses', '--buildings', '--places', '--roads', '--osm', '--nad', '--assessors', '--region', '--release-version', '--observed-at', '--generated-at', '--output']);
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
    regionKey: options.region, releaseVersion: options.release_version, observedAt: new Date(options.observed_at).toISOString(),
  });
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const generatedAt = new Date(options.generated_at || Date.now()).toISOString();
  const release = {
    schema: 'firstknock.canvas-normalized-evidence-release', schema_version: 1,
    release: { dataset_namespace: 'firstknock-overture-properties', dataset_version: `${options.release_version}.${options.region}`, generated_at: generatedAt },
    coverage: { country_codes: ['US'], bounds: result.normalized_tile.coverage.bounds },
    tile_scheme: { scheme: 'firstknock-regional-grid', scheme_version: 1 }, sources: result.sources,
    tile_inputs: ['normalized.ndjson'],
  };
  await Promise.all([
    writeFile(join(output, 'source.json'), canonicalStringify(result.source_tile)),
    writeFile(join(output, 'normalized.ndjson'), `${canonicalStringify(result.normalized_tile)}\n`),
    writeFile(join(output, 'release.json'), canonicalStringify(release)),
    writeFile(join(output, 'etl-report.json'), canonicalStringify({ ...result.report, unlinked_properties: result.unlinked_properties })),
  ]);
  return { ...result.report, output_directory: output };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runOvertureRegionBuild().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`Canvas Overture ETL failed: ${error.message}\n`); process.exitCode = 1; });