import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimPrecisionProcessorLease,
  releasePrecisionProcessorLease,
} from '../base44/functions/_shared/precisionProcessorLease.js';

test('one transaction-scoped processor lease fences pooled connections until commit', async () => {
  const held = new Set();
  const events = [];
  class FakeClient {
    constructor() {
      this.key = null;
      this.inTransaction = false;
    }
    async connect() { events.push('connect'); }
    async query(sql, parameters = []) {
      if (sql === 'BEGIN') {
        this.inTransaction = true;
        events.push('begin');
        return { rows: [] };
      }
      if (sql === 'SET LOCAL idle_in_transaction_session_timeout = 0') {
        assert.equal(this.inTransaction, true);
        events.push('disable-idle-timeout');
        return { rows: [] };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        const [key] = parameters;
        assert.equal(this.inTransaction, true);
        if (held.has(key)) return { rows: [{ claimed: false }] };
        held.add(key);
        this.key = key;
        return { rows: [{ claimed: true }] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (this.key) held.delete(this.key);
        this.key = null;
        this.inTransaction = false;
        events.push(sql.toLowerCase());
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    async end() { events.push('end'); }
  }

  const first = await claimPrecisionProcessorLease({
    ClientClass: FakeClient,
    databaseUrl: 'postgres://test',
    jobId: 'job_1',
  });
  const concurrent = await claimPrecisionProcessorLease({
    ClientClass: FakeClient,
    databaseUrl: 'postgres://test',
    jobId: 'job_1',
  });

  assert.equal(first.claimed, true);
  assert.equal(concurrent.claimed, false);
  assert.equal(held.has('precision-processor:job_1'), true);

  await releasePrecisionProcessorLease(first);
  const afterRelease = await claimPrecisionProcessorLease({
    ClientClass: FakeClient,
    databaseUrl: 'postgres://test',
    jobId: 'job_1',
  });
  assert.equal(afterRelease.claimed, true);
  await releasePrecisionProcessorLease(afterRelease);
  assert.equal(held.size, 0);
  assert.deepEqual(events, [
    'connect', 'begin', 'disable-idle-timeout',
    'connect', 'begin', 'disable-idle-timeout', 'rollback', 'end',
    'commit', 'end',
    'connect', 'begin', 'disable-idle-timeout', 'commit', 'end',
  ]);
});

test('processor lease acquisition rolls back before ending on query failure', async () => {
  const events = [];
  class FailingClient {
    async connect() { events.push('connect'); }
    async query(sql) {
      events.push(sql.toLowerCase());
      if (sql.includes('pg_try_advisory_xact_lock')) throw new Error('database unavailable');
      return { rows: [] };
    }
    async end() { events.push('end'); }
  }

  await assert.rejects(
    claimPrecisionProcessorLease({
      ClientClass: FailingClient,
      databaseUrl: 'postgres://test',
      jobId: 'job_1',
    }),
    /database unavailable/
  );
  assert.deepEqual(events, [
    'connect',
    'begin',
    'set local idle_in_transaction_session_timeout = 0',
    'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as claimed',
    'rollback',
    'end',
  ]);
});
