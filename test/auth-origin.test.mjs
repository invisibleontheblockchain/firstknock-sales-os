import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('deployed authentication stays on the origin that served FirstKnock', () => {
  const params = readSource('src/lib/app-params.js');
  const exampleEnv = readSource('env.example');
  const html = readSource('index.html');

  assert.match(params, /runtimeAppBaseUrl[\s\S]*window\.location\.origin/);
  assert.match(params, /appId: import\.meta\.env\.VITE_BASE44_APP_ID/);
  assert.match(params, /\['localhost', '127\.0\.0\.1'\]/);
  assert.doesNotMatch(params, /my-to-do-list-81bfaad7/);
  assert.match(exampleEnv, /^VITE_BASE44_APP_ID=695eb764b077190880be21de$/m);
  assert.match(exampleEnv, /^VITE_BASE44_APP_BASE_URL=https:\/\/firstknock\.online$/m);
  assert.doesNotMatch(exampleEnv, /my-to-do-list-81bfaad7/);
  assert.match(html, /const FK_PWA_RELEASE = '2026-07-28-instagram-acquisition-v1';/);
  assert.match(html, /rel="canonical" href="https:\/\/firstknock\.online\/"/);
});
