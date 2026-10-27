import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  POLL_BASE_DELAY_MS,
  POLL_GIVE_UP_AFTER_MS,
  POLL_MAX_DELAY_MS,
  RATE_LIMITED_DELAY_MS,
  classifyStatusPollError,
  nextPollDelayMs,
  retryingStatusText,
  shouldPausePolling,
  statusErrorMessage,
} from '../src/lib/precisionStatusPolling.js';
import {
  isRoadCompleted,
  markRoadCompleted,
  needsRoadCompletionBeforeSave,
} from '../src/lib/generatedRouteRoadCompletion.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

const sdkError = (status, data, message = `Request failed with status code ${status}`) =>
  Object.assign(new Error(message), { response: { status, data } });

test('status reads that can never succeed stop instead of looping as a lost connection', () => {
  assert.deepEqual(classifyStatusPollError(sdkError(404, { error: 'Job not found' })), { kind: 'gone', status: 404, message: 'Job not found' });
  assert.deepEqual(classifyStatusPollError(sdkError(403, { error: 'Not your job' })), { kind: 'gone', status: 403, message: 'Not your job' });
  assert.equal(classifyStatusPollError(sdkError(400, { error: 'job_id required' })).kind, 'gone');
  assert.deepEqual(classifyStatusPollError(sdkError(401, { error: 'Unauthorized' })), { kind: 'auth', status: 401, message: 'Unauthorized' });
});

test('outages and rate limits keep retrying, with the real reason kept', () => {
  assert.equal(classifyStatusPollError(sdkError(500, { error: 'FetchJob read failed' })).kind, 'transient');
  assert.equal(classifyStatusPollError(sdkError(500, { error: 'FetchJob read failed' })).message, 'FetchJob read failed');
  assert.equal(classifyStatusPollError(new Error('Network Error')).kind, 'transient');
  assert.equal(classifyStatusPollError(new Error('Network Error')).status, 0);
  assert.equal(classifyStatusPollError(sdkError(429, {})).kind, 'rate_limited');
  assert.equal(classifyStatusPollError(sdkError(503, { message: 'Traffic volume exceeded' })).kind, 'rate_limited');
  assert.equal(statusErrorMessage({}), 'No response from the import status service.');
  assert.equal(statusErrorMessage(new Error('x'.repeat(500))).length, 300);
});

test('failed reads back off to a ceiling and pause after a few minutes instead of half an hour', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(failures => nextPollDelayMs(failures)), [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(nextPollDelayMs(0), 2 * POLL_BASE_DELAY_MS);
  assert.equal(nextPollDelayMs(7, { rateLimited: true }), RATE_LIMITED_DELAY_MS);
  assert.ok(POLL_MAX_DELAY_MS < POLL_GIVE_UP_AFTER_MS);
  const now = Date.parse('2026-10-27T16:00:00Z');
  assert.equal(shouldPausePolling(0, now), false);
  assert.equal(shouldPausePolling(now - POLL_GIVE_UP_AFTER_MS + 1, now), false);
  assert.equal(shouldPausePolling(now - POLL_GIVE_UP_AFTER_MS, now), true);
  assert.ok(POLL_GIVE_UP_AFTER_MS <= 5 * 60_000);
  assert.equal(retryingStatusText({ kind: 'transient' }, 1), 'Import status did not answer — checking again');
  assert.equal(retryingStatusText({ kind: 'transient' }, 3), 'Import status did not answer (3 tries) — checking again');
  assert.match(retryingStatusText({ kind: 'rate_limited' }, 2), /busy/);
});

const stop = (hash) => ({ address_hash: hash, lat: 28, lng: -82 });
const route = (hashes, extra = {}) => ({ name: 'Route 1', properties: hashes.map(stop), houseCount: hashes.length, ...extra });

test('routes the build just road-optimized are saved without a second road pass', () => {
  const generated = markRoadCompleted([route(['a', 'b', 'c']), route(['d', 'e'])]);
  assert.ok(generated.every(isRoadCompleted));
  assert.ok(generated.every(candidate => !needsRoadCompletionBeforeSave(candidate)));
  // Adding precision metadata to the same route object does not change its stops.
  generated[0].metadata = { ...(generated[0].metadata || {}), precision_area: { job_id: 'job-1' } };
  assert.equal(needsRoadCompletionBeforeSave(generated[0]), false);
});

test('copies, filtered routes and changed stop orders still get the road pass before saving', () => {
  const [original] = markRoadCompleted([route(['a', 'b', 'c'])]);
  assert.equal(needsRoadCompletionBeforeSave({ ...original }), true, 'a copy is a different route');
  assert.equal(needsRoadCompletionBeforeSave({ ...original, properties: original.properties.slice(0, 2) }), true);
  original.properties = [...original.properties].reverse();
  assert.equal(isRoadCompleted(original), false, 'a reordered route is no longer the optimized one');
  assert.equal(needsRoadCompletionBeforeSave(original), true);
  assert.equal(needsRoadCompletionBeforeSave(route(['x', 'y'])), true);
});

test('saved, empty and beta-completed routes keep their existing save behavior', () => {
  assert.equal(needsRoadCompletionBeforeSave(route(['a', 'b'], { isSaved: true })), false);
  assert.equal(needsRoadCompletionBeforeSave(route([])), false);
  assert.equal(needsRoadCompletionBeforeSave(null), false);
  const beta = route(['a', 'b']);
  beta.metadata = { routing: { road_aware_routing_beta: true, property_order_fingerprint: routePropertyOrderFingerprint(beta.properties) } };
  assert.equal(needsRoadCompletionBeforeSave(beta), false);
  beta.metadata.routing.property_order_fingerprint = 'stale';
  assert.equal(needsRoadCompletionBeforeSave(beta), true);
  // Stops without an identity cannot be fingerprinted, so they are never assumed complete.
  const [anonymous] = markRoadCompleted([{ properties: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] }]);
  assert.equal(needsRoadCompletionBeforeSave(anonymous), true);
});

test('Create Route, Reorder and the import poll use these policies', () => {
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  const prompt = readFileSync(new URL('../src/components/map/TerritoryPrompt.jsx', import.meta.url), 'utf8');
  assert.match(home, /if \(needsRoadCompletionBeforeSave\(route\)\) \{/);
  assert.match(home, /markRoadCompleted\(generated\);\s*\n\s*if \(generated\['_cooldownInfo'\]\)/);
  assert.match(home, /const generated = markRoadCompleted\(roadMatrixPass\.routes\);/);
  assert.match(home, /Reason: \$\{firstSaveError\}/);
  assert.match(home, /deliveryAttempt\.save_error = firstSaveError\.slice\(0, 300\)/);
  assert.match(prompt, /const failure = classifyStatusPollError\(e\);/);
  assert.match(prompt, /failure\.kind === 'gone' \|\| failure\.kind === 'auth'/);
  assert.match(prompt, /if \(failure\.kind === 'gone'\) \{\s*\n\s*clearActivePrecisionJob\(jobId\);/);
  assert.match(prompt, /if \(shouldPausePolling\(session\.firstFailureAt, Date\.now\(\)\)\)/);
  assert.match(prompt, /setStatusCheckPaused\(\{ jobId, message: failure\.message \}\)/);
  assert.doesNotMatch(prompt, /Connection interrupted — retrying automatically/);
});
