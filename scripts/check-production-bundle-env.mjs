#!/usr/bin/env node
// Vite freezes `import.meta.env` into the shipped JS as an object literal, so a
// deployed bundle is self-reporting: whatever is absent there is absent at
// runtime, no matter what a secrets panel shows. This gate reads the live bundle
// and fails when a required VITE_ variable never reached the build.
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://firstknock.online';

// Canvas fails closed without these: the basemap renders nothing and rep
// assignment packages refuse to verify.
const DEFAULT_REQUIRED = Object.freeze([
  'VITE_CANVAS_BASEMAP_TILE_URL',
  'VITE_CANVAS_BASEMAP_ATTRIBUTION',
  'VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY',
  'VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT',
  'VITE_CANVAS_PACKAGE_SIGNING_KEY_ID',
]);

const SCRIPT_SRC_PATTERN = /<script[^>]+src="([^"]+\.js)"/g;
const ENV_KEY_PATTERN = /["']?(VITE_[A-Z0-9_]+)["']?\s*:/g;
const ENV_READ_PATTERN = /VITE_[A-Z0-9_]+/g;

function clean(value) {
  return String(value || '').trim();
}

export function parseScriptUrls(html, origin) {
  const urls = [];
  for (const match of clean(html).matchAll(SCRIPT_SRC_PATTERN)) {
    try {
      urls.push(new URL(match[1], origin).href);
    } catch {
      // A malformed src cannot be fetched; the missing-variable check reports it.
    }
  }
  return [...new Set(urls)];
}

// Injected keys appear as object properties inside the frozen env literal.
// Bare occurrences elsewhere are variables the code reads but Vite left unset.
export function parseBundleEnvironment(source) {
  const text = clean(source);
  const injected = new Set([...text.matchAll(ENV_KEY_PATTERN)].map((match) => match[1]));
  const read = new Set([...text.matchAll(ENV_READ_PATTERN)]. map((match) => match[0]));
  return {
    injected: [...injected].sort(),
    read: [...read].sort(),
  };
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw new TypeError(`${url} redirected with status ${response.status}; point --origin at the final host.`);
  }
  if (!response.ok) throw new TypeError(`${url} responded with status ${response.status}.`);
  return await response.text();
}

export async function checkProductionBundleEnv({
  origin = DEFAULT_ORIGIN,
  required = DEFAULT_REQUIRED,
  fetchImpl = fetch,
} = {}) {
  const normalizedOrigin = clean(origin);
  if (!normalizedOrigin.startsWith('https://')) throw new TypeError('An https origin is required.');
  const html = await fetchText(normalizedOrigin, fetchImpl);
  const scripts = parseScriptUrls(html, normalizedOrigin);
  if (!scripts.length) throw new TypeError(`No script bundles were found at ${normalizedOrigin}.`);

  const injected = new Set();
  const read = new Set();
  for (const script of scripts) {
    const parsed = parseBundleEnvironment(await fetchText(script, fetchImpl));
    for (const name of parsed.injected) injected.add(name);
    for (const name of parsed.read) read.add(name);
  }

  const missing = [...new Set(required)].filter((name) => !injected.has(name)).sort();
  return Object.freeze({
    ok: missing.length === 0,
    origin: normalizedOrigin,
    scripts,
    injected: [...injected].sort(),
    read: [...read].sort(),
    missing,
  });
}

export function parseArguments(argv) {
  const required = [];
  let origin = DEFAULT_ORIGIN;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--origin') {
      origin = argv[++index] || '';
      if (!origin) throw new TypeError('--origin requires a URL.');
    } else if (argument === '--require') {
      const name = argv[++index] || '';
      if (!/^VITE_[A-Z0-9_]+$/.test(name)) throw new TypeError('--require expects a VITE_ variable name.');
      required.push(name);
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, origin: DEFAULT_ORIGIN, required: DEFAULT_REQUIRED, json: false };
    } else {
      throw new TypeError(`Unknown argument: ${argument}.`);
    }
  }
  return { help: false, origin, required: required.length ? required : DEFAULT_REQUIRED, json };
}

function helpText() {
  return [
    'Usage: node scripts/check-production-bundle-env.mjs [options]',
    '',
    'Reads the deployed JS bundle and fails when a required VITE_ variable was',
    'never baked into the build.',
    '',
    'Options:',
    `  --origin URL      Deployment to inspect (default ${DEFAULT_ORIGIN}).`,
    '  --require NAME    Require one VITE_ variable (repeatable).',
    '  --json            Emit machine-readable output.',
    '  --help            Show this help.',
  ].join('\n');
}

async function runCli() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Bundle environment configuration error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  let result;
  try {
    result = await checkProductionBundleEnv({ origin: options.origin, required: options.required });
  } catch (error) {
    process.stderr.write(`Bundle environment check failed: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Production bundle environment: ${result.ok ? 'READY' : 'BLOCKED'}\n`);
    process.stdout.write(`Origin: ${result.origin}\n`);
    process.stdout.write(`Baked in: ${result.injected.join(', ') || '(none)'}\n`);
    for (const name of result.missing) {
      process.stdout.write(`- MISSING ${name}: read by the bundle but not injected at build time.\n`);
    }
    process.stdout.write(`Missing: ${result.missing.length}.\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli();