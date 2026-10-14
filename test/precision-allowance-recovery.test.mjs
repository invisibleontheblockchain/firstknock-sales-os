import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import { normalizePrecisionUsageResponse } from '../src/lib/precisionUsage.js';
import { withReadDeadline, shouldRetryRead, readRetryDelay } from '../src/lib/readRequest.js';

function usageOptions(invoke) {
  const source = readFileSync(new URL('../src/hooks/usePrecisionUsage.js', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: name => ({
      '@tanstack/react-query': { useQuery: options => options },
      '@/api/base44Client': { base44: { functions: { invoke } } },
      '@/lib/precisionUsage': { normalizePrecisionUsageResponse },
      '@/lib/readRequest': { withReadDeadline, shouldRetryRead, readRetryDelay },
    })[name],
  });
  return exports.usePrecisionUsage({ id: 'owner' });
}

test('the map usage query recovers from 500 then 429 and returns the verified balance', async () => {
  let calls = 0;
  const options = usageOptions(async () => {
    if (++calls < 3) throw Object.assign(new Error('Busy'), { response: { status: calls === 1 ? 500 : 429 } });
    return { data: {
      success: true, complete: true, version: 2, unlimited: true,
      limit: 1000000, used: 2645, reserved: 0, meter_used: 2645,
      remaining: 997355, lifetime_used: 25584, trial_used: 0, trial_remaining: 50,
    } };
  });
  const client = new QueryClient();
  try {
    const usage = await client.fetchQuery({ ...options, retryDelay: 0 });
    assert.equal(calls, 3);
    assert.equal(usage.remaining, 997355);
    assert.equal(usage.used, 2645);
    assert.equal(usage.unlimited, true);
  } finally { client.clear(); }
});

test('permission denial ends the map usage query without retries or a zero balance', async () => {
  let calls = 0;
  const options = usageOptions(async () => {
    calls++;
    throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
  });
  const client = new QueryClient();
  try {
    await assert.rejects(client.fetchQuery({ ...options, retryDelay: 0 }), /Forbidden/);
    assert.equal(calls, 1);
    assert.equal(client.getQueryData(options.queryKey), undefined);
  } finally { client.clear(); }
});

