import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { findPolygonSelfIntersection } from '../base44/shared/precisionOrderSafety.js';

const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8').replace(/^import .*;\s*$/gm, '');
const polygon = [{ lat: 33, lng: -113 }, { lat: 34, lng: -113 }, { lat: 34, lng: -112 }, { lat: 33, lng: -112 }];

function processor({ permanentFailure = false, allPagesFail = false, drain = false, databaseFailure = false, existing = 0 } = {}) {
    let handler;
    let job = { id: 'job-1', status: 'pending', user_email: 'owner@example.test',
        created_date: '2026-10-06T12:00:00Z', sold_months: 1, polygon,
        total_expected: drain ? 1000000 : 500, estimated_record_count: drain ? 1000000 : 500,
        total_fetched: existing, precision_usage_reserved: 500,
        dry_run_metadata: { count_mode: 'max_available', drain_until_exhausted: drain,
            filters: { min_price: 100000 }, processor_token: 'test-processor' } };
    const persisted = new Set(Array.from({ length: existing }, (_, i) => `existing-${i}`));
    const requests = [];
    const chains = [];
    const writes = [];
    let failedOnce = false;
    const client = { asServiceRole: { functions: { invoke: async (_name, body) => { chains.push(body); } }, entities: {
        FetchJob: { get: async () => structuredClone(job), update: async (_id, patch) => { job = { ...job, ...structuredClone(patch) }; } },
        PipelineLock: { filter: async () => [], create: async () => ({ id: 'lock-1' }), delete: async () => {} },
        User: { filter: async () => [] }
    } } };
    const sql = async (strings) => {
        const query = strings.join(' ');
        if (databaseFailure) throw new Error('database unavailable');
        if (query.includes('COUNT(*)')) return [{ count: persisted.size }];
        if (query.includes('SELECT p.address_hash')) return [...persisted].map(address_hash => ({ address_hash }));
        throw new Error(`Unexpected query: ${query}`);
    };
    const context = { createClientFromRequest: () => client, neon: () => sql,
        findPolygonSelfIntersection, console, Response, AbortController, crypto: webcrypto,
        setTimeout: callback => { queueMicrotask(callback); return 0; }, clearTimeout: () => {},
        Deno: { env: { get: () => 'test-configured' }, serve: value => { handler = value; } },
        fetch: async (_url, options) => {
            const { skip, take } = JSON.parse(options.body).options;
            requests.push({ skip, take });
            if (allPagesFail || (skip === 100 && (permanentFailure || !failedOnce))) {
                failedOnce = true;
                return { ok: false, status: 400, text: async () => 'test page failure' };
            }
            const properties = Array.from({ length: Math.max(0, Math.min(take, 600 - skip)) }, (_, index) => ({
                address: { street: `${skip + index + 100} Test St`, zip: '85001', latitude: 33.5, longitude: -112.5 },
                intel: { lastSoldDate: '2026-10-01', lastSoldPrice: 200000 },
                general: { standardizedLandUseCode: 'R2', propertyTypeDetail: 'Single Family' }
            }));
            return { ok: true, text: async () => JSON.stringify({ results: { properties, meta: { results: { resultsFound: 600 } } } }) };
        }
    };
    vm.runInNewContext(source, context);
    // The integration test exercises real orchestration against a durable fake
    // datastore. Batched SQL mechanics have their own contract coverage.
    context.writePropertiesToNeon = async (_sql, properties) => {
        writes.push(properties.map(property => property.address_hash));
        for (const property of properties) persisted.add(property.address_hash);
        return { inserted: properties.length, existed: 0, updated: 0 };
    };
    return { requests, chains, writes, persisted, job: () => job,
        invoke: async () => {
            const response = await handler(new Request('https://example.test/process', { method: 'POST',
                body: JSON.stringify({ job_id: job.id, processor_token: 'test-processor', expected_chunk: job.chunk_number || 0 }) }));
            return { status: response.status, body: await response.json() };
        } };
}

test('the processor persists successful pages before checkpointing and retrying only a failed page', async () => {
    const api = processor();
    const first = await api.invoke();
    assert.equal(first.body.status, 'chunk_complete');
    assert.equal(api.persisted.size, 400);
    assert.equal(api.job().status, 'running');
    assert.deepEqual(api.job().dry_run_metadata.pending_batchdata_pages, [{ pageSkip: 100, take: 100 }]);
    assert.equal(api.job().current_offset, 500);
    assert.equal(api.job().precision_usage_reserved, 500);
    assert.equal(api.chains.length, 1);
    const second = await api.invoke();
    assert.equal(second.body.status, 'completed');
    assert.equal(api.persisted.size, 500);
    assert.deepEqual(api.requests.slice(5), [{ skip: 100, take: 100 }]);
    assert.equal(api.job().precision_usage_count, 500);
    assert.equal(api.job().total_fetched, 500);
    assert.equal(api.job().dry_run_metadata.batchdata_summary.credit_efficiency.loss_percent, 0);
});

test('a recovered full drain resumes after successful pages and completes only at provider exhaustion', async () => {
    const api = processor({ drain: true });
    await api.invoke();
    const final = await api.invoke();
    assert.equal(final.body.status, 'completed');
    assert.equal(api.persisted.size, 600);
    assert.deepEqual(api.requests.slice(5), [{ skip: 100, take: 100 }, { skip: 500, take: 100 }]);
    assert.equal(api.job().dry_run_metadata.completion_reason, 'provider_exhausted');
    assert.equal(api.job().total_fetched, 600);
});

test('persistent page failures stop after bounded recovery while preserving delivered homes and exact usage', async () => {
    const api = processor({ permanentFailure: true });
    await api.invoke();
    await api.invoke();
    const final = await api.invoke();
    assert.equal(final.body.status, 'completed');
    assert.equal(api.job().status, 'completed');
    assert.equal(api.job().dry_run_metadata.partial_delivery, true);
    assert.equal(api.persisted.size, 400);
    assert.equal(api.job().precision_usage_count, 400);
    assert.equal(api.job().precision_usage_reserved, 0);
    assert.equal(api.job().total_fetched, 400);
    assert.equal(api.chains.length, 2);
    assert.deepEqual(api.requests.slice(5), [{ skip: 100, take: 100 }, { skip: 100, take: 100 }]);
    assert.equal(api.job().dry_run_metadata.pending_batchdata_pages.length, 1);
});

test('a delivery verification outage fails before buying records and retains the reservation', async () => {
    const api = processor({ databaseFailure: true });
    assert.equal((await api.invoke()).status, 500);
    assert.equal(api.requests.length, 0);
    assert.equal(api.job().precision_usage_reserved, 500);
    assert.equal(api.job().precision_usage_recorded_at, undefined);
});

test('a recovered job whose target is already persisted never purchases an extra record', async () => {
    const api = processor({ existing: 500 });
    assert.equal((await api.invoke()).body.status, 'completed');
    assert.equal(api.requests.length, 0);
    assert.equal(api.job().precision_usage_count, 500);
    assert.equal(api.job().dry_run_metadata.completion_reason, 'target_met');
});

test('an entirely failed pull remains failed instead of reporting a completed empty drain', async () => {
    const api = processor({ allPagesFail: true });
    await api.invoke();
    await api.invoke();
    const final = await api.invoke();
    assert.equal(final.body.status, 'failed');
    assert.equal(api.job().status, 'failed');
    assert.equal(api.persisted.size, 0);
    assert.equal(api.job().precision_usage_count, 0);
    assert.equal(api.chains.length, 2);
});
