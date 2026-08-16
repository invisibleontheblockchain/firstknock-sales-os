import { readFile } from 'node:fs/promises';
import { createPublicKey, webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  validateCanvasEvidenceManifest,
  verifyCanvasEvidenceManifest,
} from './canvas-evidence/contract.mjs';

export const CANVAS_READINESS_COMPONENTS = Object.freeze(['base44', 'analysis', 'web']);

const RELEASE_ID_PATTERN = /cer1_[a-f0-9]{64}/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{3,128}$/;
const PMTILES_FLAVORS = new Set(['carto', 'light', 'dark', 'white', 'grayscale', 'black']);
const PUBLIC_RUNTIME_HOSTS = Object.freeze([
  'tile.openstreetmap.org',
  'nominatim.openstreetmap.org',
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.private.coffee',
  'maps.mail.ru',
]);

function clean(value) {
  return String(value || '').trim();
}

function isPlaceholder(value) {
  const candidate = clean(value);
  return !candidate
    || /<[^>]+>/.test(candidate)
    || /^(?:\.{3}|change[-_ ]?me|replace[-_ ]?me|your[-_ ].*|todo|tbd|example|dummy|secret|password)$/i.test(candidate)
    || /(?:^|[./_-])your-provider(?:[./_-]|$)/i.test(candidate);
}

function normalizePem(value) {
  return clean(value).replaceAll('\\n', '\n');
}

function decodeBase64(value, label) {
  const candidate = clean(value).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)) throw new TypeError(`${label} is not base64 encoded.`);
  const bytes = Buffer.from(candidate, 'base64');
  if (!bytes.byteLength) throw new TypeError(`${label} is empty.`);
  return bytes;
}

function parseUrl(value, label, { requireReleaseAddress = false, allowQuery = true } = {}) {
  if (isPlaceholder(value)) throw new TypeError(`${label} is missing or still contains a placeholder.`);
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    throw new TypeError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new TypeError(`${label} must be a credential-free HTTPS URL without unsupported query or fragment data.`);
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    throw new TypeError(`${label} must point to a production host.`);
  }
  if (requireReleaseAddress && !RELEASE_ID_PATTERN.test(url.pathname)) {
    throw new TypeError(`${label} must be version-addressed with its cer1_ release ID in the path.`);
  }
  return url;
}

function isPublicRuntimeHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\{s\}\./, '');
  return PUBLIC_RUNTIME_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function postgresUrl(value) {
  if (isPlaceholder(value)) throw new TypeError('CANVAS_DATABASE_URL is missing or still contains a placeholder.');
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    throw new TypeError('CANVAS_DATABASE_URL is not a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname || url.pathname === '/') {
    throw new TypeError('CANVAS_DATABASE_URL must identify a PostgreSQL host, role, password, and database name.');
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) {
    throw new TypeError('CANVAS_DATABASE_URL must not point to a local database for production readiness.');
  }
  if (!['require', 'verify-ca', 'verify-full'].includes(String(url.searchParams.get('sslmode') || '').toLowerCase())) {
    throw new TypeError('CANVAS_DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full.');
  }
  return url;
}

function tileUrl(value, label) {
  const url = parseUrl(value, label);
  const raw = clean(value);
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!raw.includes(token)) throw new TypeError(`${label} must contain ${token}.`);
  }
  if (isPublicRuntimeHost(url.hostname) || /(?:overpass|nominatim)/i.test(url.hostname)) {
    throw new TypeError(`${label} cannot use a public OSM, Overpass, or Nominatim service in production.`);
  }
  return url;
}

function pmtilesUrl(value, label) {
  const url = parseUrl(value, label, { allowQuery: false });
  if (!/\.pmtiles$/i.test(url.pathname)) throw new TypeError(`${label} must end in .pmtiles.`);
  if (isPublicRuntimeHost(url.hostname) || /(?:overpass|nominatim)/i.test(url.hostname)) {
    throw new TypeError(`${label} cannot use a public OSM, Overpass, or Nominatim service in production.`);
  }
  return url;
}

function requiredSecret(env, name, minimumLength, report) {
  const value = clean(env[name]);
  if (isPlaceholder(value) || value.length < minimumLength) {
    report.fail(name, `${name} must be a non-placeholder secret with at least ${minimumLength} characters.`);
    return null;
  }
  report.pass(name, `${name} is present and meets the minimum length.`);
  return value;
}

function requiredText(env, name, report, minimumLength = 1) {
  const value = clean(env[name]);
  if (isPlaceholder(value) || value.length < minimumLength) {
    report.fail(name, `${name} is missing or still contains a placeholder.`);
    return null;
  }
  report.pass(name, `${name} is configured.`);
  return value;
}

function createReport(components) {
  const checks = [];
  const add = (status, component, name, message) => checks.push({ status, component, name, message });
  return {
    components,
    checks,
    component: null,
    pass(name, message) { add('pass', this.component, name, message); },
    warn(name, message) { add('warning', this.component, name, message); },
    fail(name, message) { add('fail', this.component, name, message); },
  };
}

async function packageSigningKeys(env, report) {
  const privateValue = clean(env.CANVAS_PACKAGE_SIGNING_PRIVATE_KEY);
  const publicValue = clean(env.CANVAS_PACKAGE_SIGNING_PUBLIC_KEY);
  const privateFormat = clean(env.CANVAS_PACKAGE_SIGNING_PRIVATE_KEY_FORMAT || 'pkcs8').toLowerCase();
  const publicFormat = clean(env.CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT || 'raw').toLowerCase();
  const keyId = requiredText(env, 'CANVAS_PACKAGE_SIGNING_KEY_ID', report, 3);

  if (!['pkcs8', 'jwk'].includes(privateFormat)) {
    report.fail('CANVAS_PACKAGE_SIGNING_PRIVATE_KEY_FORMAT', 'Canvas package private-key format must be pkcs8 or jwk.');
  }
  if (!['raw', 'spki', 'jwk'].includes(publicFormat)) {
    report.fail('CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT', 'Canvas package public-key format must be raw, spki, or jwk.');
  }
  if (keyId && !KEY_ID_PATTERN.test(keyId)) {
    report.fail('CANVAS_PACKAGE_SIGNING_KEY_ID', 'Canvas package key ID contains unsupported characters or has an invalid length.');
  }
  if (isPlaceholder(privateValue)) report.fail('CANVAS_PACKAGE_SIGNING_PRIVATE_KEY', 'Canvas package signing private key is missing or still contains a placeholder.');
  if (isPlaceholder(publicValue)) report.fail('CANVAS_PACKAGE_SIGNING_PUBLIC_KEY', 'Canvas package signing public key is missing or still contains a placeholder.');
  if (isPlaceholder(privateValue) || isPlaceholder(publicValue)
    || !['pkcs8', 'jwk'].includes(privateFormat) || !['raw', 'spki', 'jwk'].includes(publicFormat)) return;

  try {
    const privateIsJwk = privateFormat === 'jwk' || privateValue.startsWith('{');
    const publicIsJwk = publicFormat === 'jwk' || publicValue.startsWith('{');
    const privateBytes = privateValue.includes('BEGIN PRIVATE KEY')
      ? privateValue.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s/g, '')
      : privateValue;
    const privateKey = await webcrypto.subtle.importKey(
      privateIsJwk ? 'jwk' : 'pkcs8',
      privateIsJwk ? JSON.parse(privateValue) : decodeBase64(privateBytes, 'Canvas package private key'),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    let publicBytes = publicValue;
    let effectivePublicFormat = publicFormat;
    if (publicValue.includes('BEGIN PUBLIC KEY')) {
      publicBytes = publicValue.replace(/-----BEGIN PUBLIC KEY-----/g, '').replace(/-----END PUBLIC KEY-----/g, '').replace(/\s/g, '');
      effectivePublicFormat = 'spki';
    }
    const publicKey = await webcrypto.subtle.importKey(
      publicIsJwk ? 'jwk' : effectivePublicFormat,
      publicIsJwk ? JSON.parse(publicValue) : decodeBase64(publicBytes, 'Canvas package public key'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const challenge = webcrypto.getRandomValues(new Uint8Array(32));
    const signature = await webcrypto.subtle.sign({ name: 'Ed25519' }, privateKey, challenge);
    if (!await webcrypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, challenge)) {
      throw new TypeError('configured keys do not form a pair');
    }
    report.pass('CANVAS_PACKAGE_SIGNING_KEYPAIR', 'Canvas package Ed25519 keys import successfully and form a matching pair.');
  } catch {
    report.fail('CANVAS_PACKAGE_SIGNING_KEYPAIR', 'Canvas package Ed25519 keys are invalid, use unsupported encoding, or do not form a matching pair.');
  }
}

function validateCanvasDatabase(env, report) {
  try {
    postgresUrl(env.CANVAS_DATABASE_URL);
    report.pass('CANVAS_DATABASE_URL', 'Canvas operational PostgreSQL is configured with TLS.');
  } catch (error) {
    report.fail('CANVAS_DATABASE_URL', error.message);
  }
  for (const precisionName of ['PRECISION_DATABASE_URL', 'DATABASE_URL']) {
    if (clean(env[precisionName]) && clean(env[precisionName]) === clean(env.CANVAS_DATABASE_URL)) {
      report.fail('CANVAS_DATABASE_ISOLATION', `CANVAS_DATABASE_URL must not reuse ${precisionName}; Canvas and Precision storage stay isolated.`);
    }
  }
}

function rejectLegacyRuntimeProviders(env, report) {
  const forbidden = [
    'CANVAS_OVERPASS_URL',
    'CANVAS_OVERPASS_LARGE_AREA_URL',
    'CANVAS_OVERPASS_AUTH_TOKEN',
    'CANVAS_NOMINATIM_URL',
    'CANVAS_EVIDENCE_PROVIDER',
  ];
  const configured = forbidden.filter((name) => clean(env[name]));
  if (configured.length) {
    report.fail('CANVAS_STATIC_EVIDENCE_ONLY', `${configured.join(', ')} must be removed; production Canvas reads the provider identity from its signed static evidence manifest.`);
  } else {
    report.pass('CANVAS_STATIC_EVIDENCE_ONLY', 'No live Overpass, Nominatim, or browser-selected evidence provider is configured.');
  }
  const fallback = clean(env.CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK).toLowerCase();
  if (fallback && fallback !== 'false') {
    report.fail('CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK', 'Public Overpass fallback must never be enabled in production.');
  } else {
    report.pass('CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK', 'Legacy v1 public street verification is disabled; only signed residential v2 evidence is production-eligible.');
  }
}

async function checkBase44(env, report) {
  report.component = 'base44';
  validateCanvasDatabase(env, report);
  const migration = requiredSecret(env, 'CANVAS_OPERATIONAL_MIGRATION_SECRET', 32, report);
  const lifecycle = requiredSecret(env, 'CANVAS_DEPLOYMENT_SIGNING_SECRET', 32, report);
  const token = requiredSecret(env, 'CANVAS_ANALYSIS_SERVICE_TOKEN', 32, report);
  try {
    parseUrl(env.CANVAS_ANALYSIS_SERVICE_URL, 'CANVAS_ANALYSIS_SERVICE_URL', { allowQuery: false });
    report.pass('CANVAS_ANALYSIS_SERVICE_URL', 'Base44 points to a credential-free HTTPS Canvas analysis service.');
  } catch (error) {
    report.fail('CANVAS_ANALYSIS_SERVICE_URL', error.message);
  }
  await packageSigningKeys(env, report);
  const duplicateSecrets = [migration, lifecycle, token].filter(Boolean);
  if (new Set(duplicateSecrets).size !== duplicateSecrets.length) {
    report.fail('CANVAS_SECRET_SEPARATION', 'Migration, lifecycle-signing, and analysis-service secrets must be independently generated.');
  } else if (duplicateSecrets.length === 3) {
    report.pass('CANVAS_SECRET_SEPARATION', 'Canvas control-plane secrets are independently scoped.');
  }
  rejectLegacyRuntimeProviders(env, report);
}

function parseEvidencePublicKey(value) {
  const candidate = normalizePem(value);
  if (isPlaceholder(candidate)) throw new TypeError('CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY is missing or still contains a placeholder.');
  const key = candidate.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(candidate)
    : createPublicKey({ key: decodeBase64(candidate, 'Canvas evidence manifest public key'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Canvas evidence manifest public key must be Ed25519.');
  return key;
}

async function checkAnalysis(env, report, manifest) {
  report.component = 'analysis';
  validateCanvasDatabase(env, report);
  requiredSecret(env, 'CANVAS_ANALYSIS_SERVICE_TOKEN', 32, report);
  let manifestUrl = null;
  try {
    manifestUrl = parseUrl(env.CANVAS_EVIDENCE_MANIFEST_URL, 'CANVAS_EVIDENCE_MANIFEST_URL', { requireReleaseAddress: true });
    report.pass('CANVAS_EVIDENCE_MANIFEST_URL', 'Evidence manifest URL is HTTPS and version-addressed by release ID.');
  } catch (error) {
    report.fail('CANVAS_EVIDENCE_MANIFEST_URL', error.message);
  }
  let publicKey = null;
  try {
    publicKey = parseEvidencePublicKey(env.CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY);
    report.pass('CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY', 'Evidence manifest verification key is a valid Ed25519 public key.');
  } catch (error) {
    report.fail('CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY', error.message);
  }
  const keyId = requiredText(env, 'CANVAS_EVIDENCE_MANIFEST_KEY_ID', report);
  if (keyId && !KEY_ID_PATTERN.test(keyId)) {
    report.fail('CANVAS_EVIDENCE_MANIFEST_KEY_ID', 'Evidence manifest key ID contains unsupported characters or has an invalid length.');
  }
  const evidenceToken = clean(env.CANVAS_EVIDENCE_BEARER_TOKEN);
  if (evidenceToken) {
    if (isPlaceholder(evidenceToken) || evidenceToken.length < 32) report.fail('CANVAS_EVIDENCE_BEARER_TOKEN', 'Evidence bearer token must contain at least 32 non-placeholder characters when configured.');
    else report.pass('CANVAS_EVIDENCE_BEARER_TOKEN', 'Private evidence-origin bearer token is configured.');
  } else {
    report.pass('CANVAS_EVIDENCE_BEARER_TOKEN', 'Evidence origin is configured for public artifact reads; signatures and hashes still gate trust.');
  }
  rejectLegacyRuntimeProviders(env, report);

  if (!manifest) {
    report.warn('CANVAS_EVIDENCE_MANIFEST_FILE', 'Configuration is valid, but no local manifest was supplied for release signature verification.');
    return;
  }
  try {
    const metrics = validateCanvasEvidenceManifest(manifest);
    if (!publicKey || !keyId || !verifyCanvasEvidenceManifest(manifest, { publicKey, expectedKeyId: keyId })) {
      throw new TypeError('manifest signature or key ID is invalid');
    }
    if (!manifest.coverage.country_codes.includes('US')) throw new TypeError('manifest does not declare US coverage');
    if (manifestUrl && !manifestUrl.pathname.includes(metrics.release_id)) throw new TypeError('manifest URL does not pin the manifest release ID');
    report.pass('CANVAS_EVIDENCE_MANIFEST_FILE', `Signed evidence manifest ${metrics.release_id} is valid and declares ${manifest.sources.length} provider source(s).`);
  } catch {
    report.fail('CANVAS_EVIDENCE_MANIFEST_FILE', 'The supplied evidence manifest failed its schema, provider metadata, release-address, key-ID, or Ed25519 signature check.');
  }
}

async function importPackagePublicKey(value, format, label) {
  let keyData = normalizePem(value);
  let effectiveFormat = clean(format || 'spki').toLowerCase();
  if (!['raw', 'spki', 'jwk'].includes(effectiveFormat)) throw new TypeError(`${label} format must be raw, spki, or jwk.`);
  if (isPlaceholder(keyData)) throw new TypeError(`${label} is missing or still contains a placeholder.`);
  if (keyData.includes('BEGIN PUBLIC KEY')) {
    keyData = keyData.replace(/-----BEGIN PUBLIC KEY-----/g, '').replace(/-----END PUBLIC KEY-----/g, '').replace(/\s/g, '');
    effectiveFormat = 'spki';
  }
  const imported = await webcrypto.subtle.importKey(
    effectiveFormat,
    effectiveFormat === 'jwk' ? JSON.parse(keyData) : decodeBase64(keyData, label),
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  return Buffer.from(await webcrypto.subtle.exportKey('raw', imported)).toString('hex');
}

async function checkWeb(env, report) {
  report.component = 'web';
  const xyzTiles = clean(env.VITE_CANVAS_BASEMAP_TILE_URL);
  const pmtiles = clean(env.VITE_CANVAS_BASEMAP_PMTILES_URL);
  if (xyzTiles && pmtiles) {
    report.fail('VITE_CANVAS_BASEMAP_CONFIGURATION', 'Configure exactly one Canvas basemap source: XYZ tiles or PMTiles, never both.');
  } else if (pmtiles) {
    try {
      pmtilesUrl(pmtiles, 'VITE_CANVAS_BASEMAP_PMTILES_URL');
      report.pass('VITE_CANVAS_BASEMAP_CONFIGURATION', 'Production Canvas uses one configured HTTPS PMTiles archive.');
    } catch (error) {
      report.fail('VITE_CANVAS_BASEMAP_CONFIGURATION', error.message);
    }
  } else {
    try {
      tileUrl(xyzTiles, 'VITE_CANVAS_BASEMAP_TILE_URL');
      report.pass('VITE_CANVAS_BASEMAP_CONFIGURATION', 'Production Canvas uses one configured HTTPS XYZ tile endpoint.');
    } catch (error) {
      report.fail('VITE_CANVAS_BASEMAP_CONFIGURATION', error.message);
    }
  }
  requiredText(env, 'VITE_CANVAS_BASEMAP_ATTRIBUTION', report);
  const pmtilesFlavor = clean(env.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR).toLowerCase();
  if (pmtilesFlavor && !pmtiles) {
    report.fail('VITE_CANVAS_BASEMAP_PMTILES_FLAVOR', 'A PMTiles flavor may be configured only with VITE_CANVAS_BASEMAP_PMTILES_URL.');
  } else if (pmtilesFlavor && !PMTILES_FLAVORS.has(pmtilesFlavor)) {
    report.fail('VITE_CANVAS_BASEMAP_PMTILES_FLAVOR', 'PMTiles flavor must be carto, light, dark, white, grayscale, or black.');
  } else {
    report.pass('VITE_CANVAS_BASEMAP_PMTILES_FLAVOR', pmtiles ? `PMTiles uses the ${pmtilesFlavor || 'carto'} Canvas basemap flavor.` : 'PMTiles styling is not configured for the XYZ basemap.');
  }

  const satelliteUrl = clean(env.VITE_CANVAS_SATELLITE_TILE_URL);
  const satelliteAttribution = clean(env.VITE_CANVAS_SATELLITE_ATTRIBUTION);
  if (satelliteUrl || satelliteAttribution) {
    if (!satelliteUrl || !satelliteAttribution) {
      report.fail('VITE_CANVAS_SATELLITE_CONFIGURATION', 'Satellite URL and attribution must be configured together.');
    } else {
      try {
        tileUrl(satelliteUrl, 'VITE_CANVAS_SATELLITE_TILE_URL');
        report.pass('VITE_CANVAS_SATELLITE_CONFIGURATION', 'Optional satellite tiles and attribution are configured together.');
      } catch (error) {
        report.fail('VITE_CANVAS_SATELLITE_CONFIGURATION', error.message);
      }
    }
  } else {
    report.pass('VITE_CANVAS_SATELLITE_CONFIGURATION', 'Satellite imagery is intentionally disabled.');
  }

  const clientKeyId = requiredText(env, 'VITE_CANVAS_PACKAGE_SIGNING_KEY_ID', report, 3);
  if (clientKeyId && !KEY_ID_PATTERN.test(clientKeyId)) {
    report.fail('VITE_CANVAS_PACKAGE_SIGNING_KEY_ID', 'Canvas web package key ID contains unsupported characters or has an invalid length.');
  }
  let clientFingerprint = null;
  try {
    clientFingerprint = await importPackagePublicKey(
      env.VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY,
      env.VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT || 'spki',
      'VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY',
    );
    report.pass('VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY', 'The web build pins a valid Ed25519 assignment-package verification key.');
  } catch (error) {
    report.fail('VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY', error.message);
  }

  const serverPublicKey = clean(env.CANVAS_PACKAGE_SIGNING_PUBLIC_KEY);
  const serverKeyId = clean(env.CANVAS_PACKAGE_SIGNING_KEY_ID);
  if (serverPublicKey || serverKeyId) {
    try {
      const serverFingerprint = await importPackagePublicKey(
        serverPublicKey,
        env.CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT || 'raw',
        'CANVAS_PACKAGE_SIGNING_PUBLIC_KEY',
      );
      if (!clientFingerprint || clientFingerprint !== serverFingerprint || clientKeyId !== serverKeyId) {
        throw new TypeError('The web trust anchor does not match the Base44 package-signing public key and key ID.');
      }
      report.pass('CANVAS_PACKAGE_CLIENT_TRUST_MATCH', 'The independently compiled web trust anchor matches the Base44 package signer.');
    } catch (error) {
      report.fail('CANVAS_PACKAGE_CLIENT_TRUST_MATCH', error.message);
    }
  }
}

export async function checkCanvasProductionReadiness(env = process.env, {
  components = CANVAS_READINESS_COMPONENTS,
  manifest = null,
} = {}) {
  const selected = [...new Set(components)].filter((component) => CANVAS_READINESS_COMPONENTS.includes(component));
  if (!selected.length) throw new TypeError('Select at least one Canvas readiness component.');
  const report = createReport(selected);
  if (selected.includes('base44')) await checkBase44(env, report);
  if (selected.includes('analysis')) await checkAnalysis(env, report, manifest);
  if (selected.includes('web')) await checkWeb(env, report);
  const checks = report.checks;
  return Object.freeze({
    ok: !checks.some((check) => check.status === 'fail'),
    components: selected,
    checks,
    failures: checks.filter((check) => check.status === 'fail').length,
    warnings: checks.filter((check) => check.status === 'warning').length,
  });
}

export function parseCanvasReadinessArguments(argv) {
  const components = [];
  let manifestFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--component') {
      const component = argv[++index];
      if (component === 'all') components.push(...CANVAS_READINESS_COMPONENTS);
      else if (CANVAS_READINESS_COMPONENTS.includes(component)) components.push(component);
      else throw new TypeError(`Unknown Canvas readiness component: ${component || '(missing)'}.`);
    } else if (argument === '--manifest-file') {
      manifestFile = argv[++index] || null;
      if (!manifestFile) throw new TypeError('--manifest-file requires a path.');
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, components: CANVAS_READINESS_COMPONENTS, manifestFile: null, json: false };
    } else {
      throw new TypeError(`Unknown argument: ${argument}.`);
    }
  }
  return {
    help: false,
    components: components.length ? [...new Set(components)] : CANVAS_READINESS_COMPONENTS,
    manifestFile,
    json,
  };
}

function helpText() {
  return [
    'Usage: node scripts/check-canvas-production-readiness.mjs [options]',
    '',
    'Options:',
    '  --component base44|analysis|web|all  Validate one deployment surface (repeatable).',
    '  --manifest-file PATH                  Verify the signed evidence manifest for analysis.',
    '  --json                                Emit machine-readable output.',
    '  --help                                Show this help.',
  ].join('\n');
}

async function runCli() {
  let options;
  try {
    options = parseCanvasReadinessArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Canvas readiness configuration error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  let manifest = null;
  if (options.manifestFile) {
    try {
      manifest = JSON.parse(await readFile(options.manifestFile, 'utf8'));
    } catch {
      process.stderr.write('Canvas readiness configuration error: manifest file could not be read as JSON.\n');
      process.exitCode = 2;
      return;
    }
  }
  const result = await checkCanvasProductionReadiness(process.env, { components: options.components, manifest });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Canvas production readiness: ${result.ok ? 'READY' : 'BLOCKED'}\n`);
    for (const check of result.checks) {
      process.stdout.write(`- ${check.status.toUpperCase()} [${check.component}] ${check.name}: ${check.message}\n`);
    }
    process.stdout.write(`Failures: ${result.failures}; warnings: ${result.warnings}.\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli();