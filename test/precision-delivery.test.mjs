import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { limitPrecisionCandidates, precisionAreaForJob, precisionReferenceDateForJob, savePrecisionRoutes } from '../src/lib/precisionDelivery.js';
import { isPrecisionJob, precisionJobBelongsToSubject } from '../base44/shared/precisionOrderSafety.js';

test('Max Available keeps all homes while fixed and legacy count modes retain their limit', () => {
    const homes = Array.from({ length: 600 }, (_, i) => ({ id: i, rank: i }));
    assert.equal(limitPrecisionCandidates(homes, { countMode: 'max_available', requestedCount: 50 }, p => p.rank), homes);
    for (const countMode of ['fixed', undefined]) {
        const result = limitPrecisionCandidates(homes, { countMode, requestedCount: 50 }, p => p.rank);
        assert.equal(result.length, 50);
        assert.equal(result[0].id, 599);
    }
    assert.equal(homes[0].id, 0, 'ranking must not mutate the candidate set');
});

test('one failed route save cannot discard successful saves or skip remaining routes', async () => {
    const routes = Array.from({ length: 8 }, (_, id) => ({ id }));
    let active = 0;
    let maxActive = 0;
    const results = await savePrecisionRoutes(routes, async route => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        if (route.id === 2) throw new Error('save failed');
        return { id: `saved-${route.id}` };
    }, 3);
    assert.equal(maxActive, 3);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 7);
    assert.equal(results[2].status, 'rejected');
    assert.equal(results[7].value.id, 'saved-7');
});

test('route saves carry a captured job/date window without mutable UI state or processor secrets', () => {
    const job = { id: 'original-job', polygon: [{ lat: 33, lng: -112 }], total_expected: 1000, sold_months: 3,
        dry_run_metadata: { count_mode: 'max_available', processor_token: 'must-not-be-copied',
            ownership_range_mode: 'custom', ownership_range_days: { min: 30, max: 90 },
            filters: { min_price: 100000, max_price: 500000 } } };
    const captured = precisionAreaForJob(job, '2026-10-06T12:00:00Z');
    job.id = 'later-job';
    job.polygon[0].lat = 40;
    job.dry_run_metadata.ownership_range_days.min = 60;
    assert.equal(captured.job_id, 'original-job');
    assert.equal(captured.polygon[0].lat, 33);
    assert.deepEqual(captured.criteria.ownership_range_days, { min: 30, max: 90 });
    assert.equal(captured.criteria.count_mode, 'max_available');
    assert.equal(JSON.stringify(captured).includes('must-not-be-copied'), false);
});

test('zone-less provider job timestamps retain UTC date bounds in every browser zone', () => {
    assert.equal(precisionReferenceDateForJob({ created_date: '2026-10-06T23:30:00.123000' }), '2026-10-06T23:30:00.123Z');
    assert.equal(precisionReferenceDateForJob({ created_date: '2026-10-06T23:30:00.123Z' }), '2026-10-06T23:30:00.123Z');
    assert.equal(precisionReferenceDateForJob({ created_date: '2026-10-06T16:30:00-07:00' }), '2026-10-06T23:30:00.000Z');
    assert.equal(precisionReferenceDateForJob({ created_date: 'bad-date' }), null);
});

const source = fs.readFileSync('base44/functions/recordPrecisionDelivery/entry.ts', 'utf8').replace(/^import .*;\s*$/gm, '');
const user = { id: 'manager-1', email: 'owner@example.test' };
const job = { id: 'job-1', status: 'completed', provider: 'batchdata', mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: user.id, user_email: user.email, total_fetched: 10,
    precision_usage_count: 4, precision_usage_reserved: 0,
    dry_run_metadata: { count_mode: 'max_available', batchdata_summary: { reviewed: 10, active: 4 } } };
const report = { job_id: job.id, attempt_id: 'attempt-1', status: 'completed', candidate_homes: 4,
    generated_homes: 4, in_memory_homes: 2, failed_route_saves: 1,
    filter_stages: [{ name: 'initial', count: 4 }, { name: 'priceYear', count: 3 }, { name: 'countLimit', count: 3 }] };
const ownedRoute = (overrides = {}) => ({ id: 'route-1', manager_id: user.id, status: 'ACTIVE',
    metadata: { precision_area: { job_id: job.id } }, property_hashes: ['a', 'b'], ...overrides });

function endpoint({ actor = user, fetchJob = job, routes = [ownedRoute()], imported = ['a', 'b', 'c', 'd'], routeFailure = false } = {}) {
    let handler;
    const updates = [];
    const queries = [];
    const sqlCalls = [];
    const client = { auth: { me: async () => actor }, asServiceRole: { entities: {
        FetchJob: { get: async () => fetchJob, update: async (id, patch) => { updates.push({ id, patch }); } },
        SavedRoute: { filter: async (query, sort, limit, offset) => {
            queries.push({ query, sort, limit, offset });
            if (routeFailure) throw new Error('route read failed');
            return routes.slice(offset, offset + limit);
        } }
    } } };
    vm.runInNewContext(source, { createClientFromRequest: () => client,
        isPrecisionJob, precisionJobBelongsToSubject, Response, console,
        Deno: { env: { get: () => 'test-db' }, serve: value => { handler = value; } },
        neon: () => async (strings, ...values) => {
            sqlCalls.push({ query: strings.join(' '), values });
            return imported.map(address_hash => ({ address_hash }));
        }
    });
    return { updates, queries, sqlCalls,
        invoke: async (body = report) => {
            const response = await handler(new Request('https://example.test/record', {
                method: 'POST', body: JSON.stringify(body)
            }));
            return { status: response.status, body: await response.json() };
        } };
}

test('delivery accounting verifies owned saved homes, dedupes hashes, and never edits billing counters', async () => {
    const api = endpoint({ routes: [ownedRoute({ property_hashes: ['a', 'b', 'b', 'foreign'] }),
        ownedRoute({ id: 'route-2', property_hashes: ['a'] }),
        ownedRoute({ manager_id: 'other', property_hashes: ['c'] }),
        ownedRoute({ metadata: { precision_area: { job_id: 'other-job' } }, property_hashes: ['c'] }),
        ownedRoute({ status: 'ARCHIVED', property_hashes: ['d'] })] });
    const result = await api.invoke({ ...report, precision_usage_count: 999999, saved_homes: 999999 });
    assert.equal(result.status, 200);
    const final = result.body.final_delivery;
    assert.equal(final.saved_route_homes_verified, 2);
    assert.equal(final.imported_route_active_homes_verified, 4);
    assert.equal(final.returned_records_not_in_saved_routes, 8);
    assert.equal(final.saved_route_loss_percent, 80);
    assert.equal(final.in_memory_homes_reported, 2);
    assert.equal(final.filter_stages_reported[1].dropped, 1);
    assert.deepEqual(Object.keys(api.updates[0].patch), ['dry_run_metadata']);
    assert.equal(api.updates[0].patch.dry_run_metadata.batchdata_summary.active, 4);
    assert.deepEqual(api.sqlCalls[0].values, [job.id, user.email]);
    assert.equal(api.queries[0].query.manager_id, user.id);
    assert.equal(api.queries[0].query['metadata.precision_area.job_id'], job.id);
});

test('route verification paginates beyond 500 and counts each delivered home once', async () => {
    const routes = Array.from({ length: 501 }, (_, i) => ownedRoute({ id: `r-${i}`, property_hashes: [i === 500 ? 'b' : 'a'] }));
    const api = endpoint({ routes });
    const result = await api.invoke();
    assert.equal(result.body.final_delivery.saved_route_homes_verified, 2);
    assert.deepEqual(api.queries.map(query => query.offset), [0, 500]);
});

test('immutable ownership blocks cross-account reports despite matching email and admin flags', async () => {
    const api = endpoint({ actor: { id: 'other', email: user.email, role: 'admin', is_owner: true } });
    assert.equal((await api.invoke()).status, 404);
    assert.equal(api.sqlCalls.length, 0);
    assert.equal(api.updates.length, 0);
});

test('running jobs, anonymous callers, and invalid counts cannot write observations', async () => {
    assert.equal((await endpoint({ fetchJob: { ...job, status: 'running' } }).invoke()).status, 409);
    assert.equal((await endpoint({ actor: null }).invoke()).status, 401);
    for (const body of [{ ...report, candidate_homes: -1 }, { ...report, in_memory_homes: 0.5 },
        { ...report, filter_stages: [{ name: 'initial', count: 4 }, { name: 'later', count: 5 }] }]) {
        const api = endpoint();
        assert.equal((await api.invoke(body)).status, 400);
        assert.equal(api.updates.length, 0);
    }
});

test('failed saved-route verification does not record a false zero-delivery result', async () => {
    const api = endpoint({ routeFailure: true });
    assert.equal((await api.invoke()).status, 500);
    assert.equal(api.updates.length, 0);
});
