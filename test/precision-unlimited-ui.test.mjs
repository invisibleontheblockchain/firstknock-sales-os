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

test('PWA release registers a network-only refresh worker', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const worker = fs.readFileSync('public/sw.js', 'utf8');
  assert.match(html, /serviceWorker\.register\('\/sw\.js'/);
  assert.match(html, /2026-08-20-precision-entitlement-v2/);
  assert.doesNotMatch(worker, /cache\.put|caches\.open/);
});