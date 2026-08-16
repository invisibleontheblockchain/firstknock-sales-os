import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  checkProductionBundleEnv,
  parseArguments,
  parseBundleEnvironment,
  parseScriptUrls,
} from '../scripts/check-production-bundle-env.mjs';

const ORIGIN = 'https://example.test';

function stubFetch(files) {
  return async (url) => {
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
}

test('script sources resolve against the deployment origin', () => {
  const html = '<script type="module" crossorigin src="/assets/app-abc.js"></script>';
  assert.deepEqual(parseScriptUrls(html, ORIGIN), [`${ORIGIN}/assets/app-abc.js`]);
});

test('injected variables are the ones present as env object keys', () => {
  const parsed = parseBundleEnvironment('{MODE:"production",VITE_BASE44_APP_ID:"a"};x.VITE_CANVAS_BASEMAP_TILE_URL');
  assert.deepEqual(parsed.injected, ['VITE_BASE44_APP_ID']);
  assert.ok(parsed.read.includes('VITE_CANVAS_BASEMAP_TILE_URL'));
});

test('a bundle missing a required variable blocks the deployment', async () => {
  const result = await checkProductionBundleEnv({
    origin: ORIGIN,
    required: ['VITE_CANVAS_BASEMAP_TILE_URL'],
    fetchImpl: stubFetch({
      [ORIGIN]: '<script src="/assets/app-abc.js"></script>',
      [`${ORIGIN}/assets/app-abc.js`]: '{MODE:"production",VITE_BASE44_APP_ID:"a"}',
    }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['VITE_CANVAS_BASEMAP_TILE_URL']);
});

test('a bundle carrying the required variable passes', async () => {
  const result = await checkProductionBundleEnv({
    origin: ORIGIN,
    required: ['VITE_CANVAS_BASEMAP_TILE_URL'],
    fetchImpl: stubFetch({
      [ORIGIN]: '<script src="/assets/app-abc.js"></script>',
      [`${ORIGIN}/assets/app-abc.js`]: '{MODE:"production",VITE_CANVAS_BASEMAP_TILE_URL:"https://t/{z}/{x}/{y}.png"}',
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('plain http origins are refused', async () => {
  await assert.rejects(() => checkProductionBundleEnv({ origin: 'http://example.test' }), /https origin/);
});

test('arguments default to the Canvas blockers and reject unknown flags', () => {
  const parsed = parseArguments([]);
  assert.ok(parsed.required.includes('VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY'));
  assert.throws(() => parseArguments(['--nope']), /Unknown argument/);
  assert.throws(() => parseArguments(['--require', 'CANVAS_SECRET']), /VITE_ variable/);
});