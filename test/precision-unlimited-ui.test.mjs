import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePrecisionUsageResponse } from '../src/lib/precisionUsage.js';

const unlimitedPayload = {
  success: true, complete: true, version: 2,
  limit: 1000000, used: 89, reserved: 0, meter_used: 89,
  remaining: 999911, lifetime_used: 89, trial_used: 50,
  trial_remaining: 0, percent: 0, paid_access: true,
  pro_access: true, unlimited: true
};

test('owner grant stays unlimited after frontend normalization', () => {
  const usage = normalizePrecisionUsageResponse(unlimitedPayload);
  assert.equal(usage.limit, 1000000);
  assert.equal(usage.unlimited, true);
});

test('Billing labels the owner grant Unlimited instead of a numeric meter', () => {
  const billing = fs.readFileSync('src/pages/Billing.jsx', 'utf8');
  assert.match(billing, /precisionUsage\.unlimited \? 'Unlimited'/);
  assert.match(billing, /!precisionUsage\.unlimited/);
});

test('the live start gate exposes an admin-only target-account dry run', () => {
  const start = fs.readFileSync('base44/functions/startBatchDataPull/entry.ts', 'utf8');
  assert.match(start, /body\.dry_run !== true.*authenticatedUser\.role/s);
  assert.match(start, /diagnostic_user_id: body\.diagnostic_user_id \? user\.id : null/);
});

test('every production build generates a new PWA release', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const vite = fs.readFileSync('vite.config.js', 'utf8');
  const worker = fs.readFileSync('public/sw.js', 'utf8');
  const refreshManager = fs.readFileSync('src/components/AppRefreshManager.jsx', 'utf8');
  assert.match(html, /serviceWorker\.register\('\/sw\.js'/);
  assert.match(html, /preview\(\?:-sandbox\)\?.*base44.*getRegistrations/s);
  assert.match(html, /PWA registration skipped/);
  assert.match(html, /PWA foreground update check skipped/);
  assert.match(html, /__FK_BUILD_RELEASE__/);
  assert.match(vite, /Date\.now\(\).*transformIndexHtml.*dist\/sw\.js/s);
  assert.match(worker, /request\.mode === 'navigate'.*cache: 'no-store'/s);
  assert.match(refreshManager, /checkForPublishedRelease/);
  assert.doesNotMatch(worker, /cache\.put|caches\.open/);
});