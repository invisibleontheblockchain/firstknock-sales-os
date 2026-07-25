import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTCOME_CLOCK_SKEW_MS,
  collectUnretiredOutcomes,
  isOutcomeRowPresent
} from '../src/components/logic/optimisticOutcomes.js';

const LOGGED_AT = '2026-07-25T18:00:00.000Z';

const optimistic = (overrides = {}) => ({
  id: 'optimistic-1',
  address_hash: 'hash-a',
  parsed_status: 'NO_ANSWER',
  created_date: LOGGED_AT,
  ...overrides
});

const pendingMap = (...entries) => new Map(entries.map((entry) => [entry.id, entry]));

test('a row is not retired while its real row is still missing', () => {
  const entry = optimistic({ server_id: 'server-1' });
  assert.equal(isOutcomeRowPresent([], entry), false);
  assert.equal(isOutcomeRowPresent([{ id: 'unrelated', address_hash: 'hash-a' }], entry), false);
});

test('a row is retired once the id it stands for appears', () => {
  const entry = optimistic({ server_id: 'server-1' });
  assert.equal(isOutcomeRowPresent([{ id: 'server-1', address_hash: 'hash-a' }], entry), true);
});

// The write may report success without telling us which row it created. That
// must degrade to a slower retirement, never to a door that reverts.
test('without a server id, a matching outcome retires the row', () => {
  const entry = optimistic();
  const serverRow = {
    id: 'server-1',
    address_hash: 'hash-a',
    parsed_status: 'NO_ANSWER',
    created_date: LOGGED_AT
  };
  assert.equal(isOutcomeRowPresent([serverRow], entry), true);
});

test('without a server id, a different outcome on the same door does not retire it', () => {
  const entry = optimistic();
  const staleRow = {
    id: 'server-0',
    address_hash: 'hash-a',
    parsed_status: 'CALLBACK',
    created_date: LOGGED_AT
  };
  assert.equal(isOutcomeRowPresent([staleRow], entry), false);
});

test('without a server id, an older row for the same outcome does not retire it', () => {
  const entry = optimistic();
  const olderRow = {
    id: 'server-0',
    address_hash: 'hash-a',
    parsed_status: 'NO_ANSWER',
    created_date: new Date(Date.parse(LOGGED_AT) - OUTCOME_CLOCK_SKEW_MS - 60_000).toISOString()
  };
  assert.equal(isOutcomeRowPresent([olderRow], entry), false);
});

test('clock skew between device and server still retires the row', () => {
  const entry = optimistic();
  const skewedRow = {
    id: 'server-1',
    address_hash: 'hash-a',
    parsed_status: 'NO_ANSWER',
    created_date: new Date(Date.parse(LOGGED_AT) - 30_000).toISOString()
  };
  assert.equal(isOutcomeRowPresent([skewedRow], entry), true);
});

test('the optimistic row never matches itself', () => {
  const entry = optimistic();
  assert.equal(isOutcomeRowPresent([{ ...entry }], entry), false);
});

test('an unretired outcome keeps being re-applied across refetches', () => {
  const entry = optimistic({ server_id: 'server-1' });
  const map = pendingMap(entry);

  // Refetch that has not caught up: the door must stay marked.
  assert.deepEqual(collectUnretiredOutcomes(map, []), [entry]);
  assert.equal(map.size, 1);

  // And again — retirement is not a one-shot chance.
  assert.deepEqual(collectUnretiredOutcomes(map, []), [entry]);
  assert.equal(map.size, 1);

  // Once the real row lands it is retired and no longer re-applied.
  assert.deepEqual(collectUnretiredOutcomes(map, [{ id: 'server-1' }]), []);
  assert.equal(map.size, 0);
});

test('retirement is per row, so one landing does not retire the others', () => {
  const landed = optimistic({ id: 'optimistic-1', server_id: 'server-1' });
  const stillPending = optimistic({ id: 'optimistic-2', address_hash: 'hash-b', server_id: 'server-2' });
  const map = pendingMap(landed, stillPending);

  assert.deepEqual(collectUnretiredOutcomes(map, [{ id: 'server-1' }]), [stillPending]);
  assert.equal(map.has('optimistic-1'), false);
  assert.equal(map.has('optimistic-2'), true);
});

test('an address filter neither returns nor retires other doors', () => {
  const other = optimistic({ id: 'optimistic-2', address_hash: 'hash-b', server_id: 'server-2' });
  const map = pendingMap(optimistic({ server_id: 'server-1' }), other);

  // A history query for hash-b must not retire the hash-a entry just because
  // its row is absent from a result set that could never contain it.
  const unretired = collectUnretiredOutcomes(map, [], 'hash-b');
  assert.deepEqual(unretired, [other]);
  assert.equal(map.size, 2);
});

test('an empty pending map is a no-op', () => {
  const map = new Map();
  assert.deepEqual(collectUnretiredOutcomes(map, [{ id: 'server-1' }]), []);
  assert.equal(map.size, 0);
});
