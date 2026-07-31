import test from 'node:test';
import assert from 'node:assert/strict';
import { getRouteOutcomeStats, getRerunHashes, buildRerunRoutePayload, dedupeRerunHashes } from '../src/components/routes/routeRerunUtils.js';

const route = {
  id: 'route-1',
  name: 'Completed Route',
  status: 'COMPLETED',
  // Same door stored under both its modern and legacy hash — this is the
  // duplication source that inflated rerun routes.
  property_hashes: ['hash-a', 'legacy-a', 'hash-b', 'hash-b', 'hash-c'],
  properties: [
    { id: 'p1', address_hash: 'hash-a', legacy_hash: 'legacy-a' },
    { id: 'p2', address_hash: 'hash-b' },
    { id: 'p3', address_hash: 'hash-c' }
  ]
};

test('dedupeRerunHashes collapses legacy/modern aliases to one hash per door', () => {
  const deduped = dedupeRerunHashes(route, route.property_hashes);
  assert.deepEqual(deduped, ['hash-a', 'hash-b', 'hash-c']);
});

test('getRerunHashes(all) returns one hash per door', () => {
  const stats = getRouteOutcomeStats(route, []);
  const hashes = getRerunHashes(route, stats, 'all');
  assert.deepEqual(hashes, ['hash-a', 'hash-b', 'hash-c']);
});

test('getRerunHashes filters still dedupe aliases sharing an outcome log', () => {
  const logs = [
    { address_hash: 'hash-a', parsed_status: 'NO_ANSWER', created_date: '2026-07-01T00:00:00Z' },
    { address_hash: 'hash-b', parsed_status: 'SOLD', created_date: '2026-07-01T00:00:00Z' }
  ];
  const stats = getRouteOutcomeStats(route, logs);
  const hashes = getRerunHashes(route, stats, 'no_answer');
  assert.deepEqual(hashes, ['hash-a']);
  const unsold = getRerunHashes(route, stats, 'unsold');
  assert.deepEqual(unsold, ['hash-a', 'hash-c']);
});

test('buildRerunRoutePayload stores deduped hashes and a matching house count', () => {
  const payload = buildRerunRoutePayload(route, ['hash-a', 'legacy-a', 'hash-b'], 'all', 'All Doors');
  assert.deepEqual(payload.property_hashes, ['hash-a', 'hash-b']);
  assert.equal(payload.metrics.house_count, 2);
});

test('dedupeRerunHashes without hydrated properties still removes exact duplicates', () => {
  const bareRoute = { property_hashes: ['h1', 'h1', 'h2'] };
  assert.deepEqual(dedupeRerunHashes(bareRoute, bareRoute.property_hashes), ['h1', 'h2']);
});