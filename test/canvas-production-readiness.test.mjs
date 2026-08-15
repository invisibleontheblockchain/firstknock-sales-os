import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANVAS_READINESS_COMPONENTS,
  checkCanvasProductionReadiness,
  parseCanvasReadinessArguments,
} from '../scripts/check-canvas-production-readiness.mjs';
import { compileLocalFixture } from '../scripts/canvas-evidence/compile-fixture.mjs';
import {
  LOCAL_FIXTURE_KEY_ID,
  LOCAL_FIXTURE_PUBLIC_KEY,
} from '../scripts/canvas-evidence/local-fixture-keys.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');

function packageKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const encodedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    CANVAS_PACKAGE_SIGNING_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: encodedPublicKey,
    CANVAS_PACKAGE_SIGNING_PRIVATE_KEY_FORMAT: 'pkcs8',
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'spki',
    CANVAS_PACKAGE_SIGNING_KEY_ID: 'canvas-field-packages-2026-08',
    VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: encodedPublicKey,
    VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'spki',
    VITE_CANVAS_PACKAGE_SIGNING_KEY_ID: 'canvas-field-packages-2026-08',
  };
}

async function validEnvironment() {
  const fixture = await compileLocalFixture();
  return {
    fixture,
    env: {
      CANVAS_DATABASE_URL: 'postgresql://canvas_app:strong-password@canvas-db.internal.test/firstknock_canvas?sslmode=require',
      CANVAS_OPERATIONAL_MIGRATION_SECRET: 'migration-secret-isolated-0123456789abcdef',
      CANVAS_DEPLOYMENT_SIGNING_SECRET: 'lifecycle-secret-isolated-0123456789abcdef',
      CANVAS_ANALYSIS_SERVICE_URL: 'https://canvas-analysis.internal.test',
      CANVAS_ANALYSIS_SERVICE_TOKEN: 'analysis-token-isolated-0123456789abcdef',
      CANVAS_EVIDENCE_MANIFEST_URL: `https://canvas-evidence.internal.test/releases/${fixture.manifest.release.release_id}/manifest.json`,
      CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY: LOCAL_FIXTURE_PUBLIC_KEY,
      CANVAS_EVIDENCE_MANIFEST_KEY_ID: LOCAL_FIXTURE_KEY_ID,
      VITE_CANVAS_BASEMAP_TILE_URL: 'https://canvas-tiles.internal.test/streets/{z}/{x}/{y}.png',
      VITE_CANVAS_BASEMAP_ATTRIBUTION: 'FirstKnock map data providers',
      ...packageKeys(),
    },
  };
}

test('complete Canvas production configuration and signed manifest pass every deployment surface', async () => {
  const { env, fixture } = await validEnvironment();
  const result = await checkCanvasProductionReadiness(env, { manifest: fixture.manifest });
  assert.equal(result.ok, true);
  assert.equal(result.failures, 0);
  assert.equal(result.warnings, 0);
  assert.deepEqual(result.components, CANVAS_READINESS_COMPONENTS);
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_PACKAGE_SIGNING_KEYPAIR' && entry.status === 'pass'));
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_EVIDENCE_MANIFEST_FILE' && entry.status === 'pass'));
});

test('readiness fails closed for missing secrets, non-TLS databases, and reused Precision storage', async () => {
  const { env } = await validEnvironment();
  env.CANVAS_DATABASE_URL = 'postgresql://canvas:password@localhost/canvas';
  env.DATABASE_URL = env.CANVAS_DATABASE_URL;
  env.CANVAS_OPERATIONAL_MIGRATION_SECRET = 'change-me';
  env.CANVAS_ANALYSIS_SERVICE_URL = 'http://localhost:8080';
  const result = await checkCanvasProductionReadiness(env, { components: ['base44'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_DATABASE_URL' && entry.status === 'fail'));
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_DATABASE_ISOLATION' && entry.status === 'fail'));
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_OPERATIONAL_MIGRATION_SECRET' && entry.status === 'fail'));
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_ANALYSIS_SERVICE_URL' && entry.status === 'fail'));
});

test('assignment-package keys must import as a matching Ed25519 pair', async () => {
  const { env } = await validEnvironment();
  env.CANVAS_PACKAGE_SIGNING_PUBLIC_KEY = packageKeys().CANVAS_PACKAGE_SIGNING_PUBLIC_KEY;
  const result = await checkCanvasProductionReadiness(env, { components: ['base44'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_PACKAGE_SIGNING_KEYPAIR' && entry.status === 'fail'));
});

test('production web configuration rejects public OSM and incomplete satellite configuration', async () => {
  const result = await checkCanvasProductionReadiness({
    VITE_CANVAS_BASEMAP_TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    VITE_CANVAS_BASEMAP_ATTRIBUTION: 'OpenStreetMap',
    VITE_CANVAS_SATELLITE_TILE_URL: 'https://satellite.internal.test/{z}/{x}/{y}.jpg',
  }, { components: ['web'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'VITE_CANVAS_BASEMAP_CONFIGURATION' && entry.status === 'fail'));
  assert.ok(result.checks.some((entry) => entry.name === 'VITE_CANVAS_SATELLITE_CONFIGURATION' && entry.status === 'fail'));
});

test('production web configuration accepts one HTTPS PMTiles archive and rejects ambiguous dual basemaps', async () => {
  const { env } = await validEnvironment();
  delete env.VITE_CANVAS_BASEMAP_TILE_URL;
  env.VITE_CANVAS_BASEMAP_PMTILES_URL = 'https://canvas-r2.internal.test/maps/firstknock-us.pmtiles';
  let result = await checkCanvasProductionReadiness(env, { components: ['web'] });
  assert.equal(result.ok, true);
  assert.ok(result.checks.some((entry) => entry.name === 'VITE_CANVAS_BASEMAP_CONFIGURATION' && entry.status === 'pass'));
  env.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR = 'neon-rainbow';
  result = await checkCanvasProductionReadiness(env, { components: ['web'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'VITE_CANVAS_BASEMAP_PMTILES_FLAVOR' && entry.status === 'fail'));
  env.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR = 'dark';
  env.VITE_CANVAS_BASEMAP_TILE_URL = 'https://canvas-tiles.internal.test/{z}/{x}/{y}.png';
  result = await checkCanvasProductionReadiness(env, { components: ['web'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'VITE_CANVAS_BASEMAP_CONFIGURATION' && entry.status === 'fail'));
});

test('production web package trust is mandatory and must match the Base44 signer independently', async () => {
  const { env } = await validEnvironment();
  delete env.VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY;
  let result = await checkCanvasProductionReadiness(env, { components: ['web'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY' && entry.status === 'fail'));

  Object.assign(env, packageKeys());
  env.VITE_CANVAS_PACKAGE_SIGNING_KEY_ID = 'wrong-client-key-id';
  result = await checkCanvasProductionReadiness(env, { components: ['web'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_PACKAGE_CLIENT_TRUST_MATCH' && entry.status === 'fail'));
});

test('analysis configuration rejects live provider fallbacks and a tampered signed manifest', async () => {
  const { env, fixture } = await validEnvironment();
  env.CANVAS_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  const tampered = structuredClone(fixture.manifest);
  tampered.sources[0].provider = 'Tampered provider';
  const result = await checkCanvasProductionReadiness(env, { components: ['analysis'], manifest: tampered });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_STATIC_EVIDENCE_ONLY' && entry.status === 'fail'));
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_EVIDENCE_MANIFEST_FILE' && entry.status === 'fail'));
});

test('analysis configuration without a local release artifact is explicit but remains configuration-ready', async () => {
  const { env } = await validEnvironment();
  const result = await checkCanvasProductionReadiness(env, { components: ['analysis'] });
  assert.equal(result.ok, true);
  assert.equal(result.warnings, 1);
  assert.ok(result.checks.some((entry) => entry.name === 'CANVAS_EVIDENCE_MANIFEST_FILE' && entry.status === 'warning'));
});

test('readiness argument parser supports repeatable surfaces and rejects unknown inputs', () => {
  assert.deepEqual(parseCanvasReadinessArguments(['--component', 'base44', '--component', 'web', '--json']), {
    help: false,
    components: ['base44', 'web'],
    manifestFile: null,
    json: true,
  });
  assert.throws(() => parseCanvasReadinessArguments(['--component', 'provider']), /Unknown Canvas readiness component/);
  assert.throws(() => parseCanvasReadinessArguments(['--manifest-file']), /requires a path/);
});

test('readiness CLI exits nonzero and never prints configured secret values on failure', () => {
  const marker = 'do-not-print-this-secret-0123456789';
  const result = spawnSync(process.execPath, [
    'scripts/check-canvas-production-readiness.mjs',
    '--component', 'base44',
    '--json',
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      CANVAS_ANALYSIS_SERVICE_TOKEN: marker,
      CANVAS_OPERATIONAL_MIGRATION_SECRET: marker,
      CANVAS_DEPLOYMENT_SIGNING_SECRET: marker,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(marker));
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
});

test('the production runbook and examples enumerate every Canvas trust boundary without changing Precision', () => {
  const runbook = readFileSync(resolve(rootDir, 'docs/CANVAS_PRODUCTION_RUNBOOK.md'), 'utf8');
  const base44Example = readFileSync(resolve(rootDir, 'docs/canvas-base44-secrets.example'), 'utf8');
  const serviceExample = readFileSync(resolve(rootDir, 'services/canvas-analysis-service/canvas-analysis.env.example'), 'utf8');
  const clientExample = readFileSync(resolve(rootDir, 'env.example'), 'utf8');
  for (const name of [
    'CANVAS_DATABASE_URL',
    'CANVAS_OPERATIONAL_MIGRATION_SECRET',
    'CANVAS_DEPLOYMENT_SIGNING_SECRET',
    'CANVAS_ANALYSIS_SERVICE_URL',
    'CANVAS_ANALYSIS_SERVICE_TOKEN',
    'CANVAS_PACKAGE_SIGNING_PRIVATE_KEY',
    'CANVAS_PACKAGE_SIGNING_PUBLIC_KEY',
    'CANVAS_EVIDENCE_MANIFEST_URL',
    'CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY',
    'CANVAS_EVIDENCE_MANIFEST_KEY_ID',
    'VITE_CANVAS_BASEMAP_TILE_URL',
    'VITE_CANVAS_BASEMAP_PMTILES_URL',
    'VITE_CANVAS_BASEMAP_ATTRIBUTION',
    'VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY',
    'VITE_CANVAS_PACKAGE_SIGNING_KEY_ID',
  ]) assert.match(`${runbook}\n${base44Example}\n${serviceExample}\n${clientExample}`, new RegExp(name));
  assert.match(runbook, /public Overpass[\s\S]*development-only/i);
  assert.match(runbook, /public OpenStreetMap[\s\S]*development-only/i);
  assert.match(runbook, /Nominatim[\s\S]*development-only/i);
  assert.match(runbook, /Precision mode is unaffected/i);
});
