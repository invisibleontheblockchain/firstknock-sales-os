import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { mapWithConcurrency } from '../src/lib/mapWithConcurrency.js';
import { isTransientReadError, readRetryDelay, retryRead, shouldRetryRead, withReadDeadline } from '../src/lib/readRequest.js';

test('read retries recover from temporary failures and stay bounded', async () => {
  let calls = 0;
  const pauses = [];
  const result = await retryRead(() => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('Busy'), { status: 429 });
    return { id: 'rep-1' };
  }, { delay: attempt => 10 * (attempt + 1), wait: async ms => pauses.push(ms) });
  assert.equal(result.id, 'rep-1');
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [10, 20]);

  calls = 0;
  await assert.rejects(retryRead(() => {
    calls++;
    throw Object.assign(new Error('Unavailable'), { status: 503 });
  }, { wait: async () => {} }), /Unavailable/);
  assert.equal(calls, 3);
});

test('expired sessions and denied reads are not retried', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    await assert.rejects(retryRead(() => {
      calls++;
      throw Object.assign(new Error('Denied'), { response: { status } });
    }, { wait: async () => {} }), /Denied/);
    assert.equal(calls, 1);
  }
  assert.equal(isTransientReadError(new Error('Network Error')), true);
  assert.equal(shouldRetryRead(2, { status: 503 }), false);
});

test('a stalled read reaches an actionable timeout instead of spinning forever', async () => {
  await assert.rejects(withReadDeadline(() => new Promise(() => {}), 10), error => {
    assert.equal(error.code, 'READ_TIMEOUT');
    assert.equal(error.status, 408);
    return true;
  });
  assert.equal(await withReadDeadline(() => 'ready', 10), 'ready');
});

test('query retries recover a failed initial load rather than caching an empty result', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryRead, retryDelay: 0 } } });
  let calls = 0;
  const routes = await client.fetchQuery({ queryKey: ['myRoutes', 'rep-1'], queryFn: () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('Busy'), { status: 503 });
    return [{ id: 'route-1' }];
  } });
  assert.deepEqual(routes, [{ id: 'route-1' }]);
  assert.equal(calls, 3);
  client.clear();
});

test('retry jitter stays within its backoff budget', () => {
  for (const attempt of [0, 1, 2, 3, 5]) {
    const base = Math.min(1000 * 2 ** attempt, 8000);
    const delay = readRetryDelay(attempt);
    assert.ok(delay >= base && delay < base + 500);
  }
});

test('large collections limit simultaneous lookups and preserve route order', async () => {
  let active = 0;
  let peak = 0;
  const input = Array.from({ length: 30 }, (_, i) => i);
  const result = await mapWithConcurrency(input, async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, (value % 3) + 1));
    active--;
    return `route-${value}`;
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(result, input.map(value => `route-${value}`));
  assert.deepEqual(await mapWithConcurrency([], () => assert.fail('empty collection')), []);
});
