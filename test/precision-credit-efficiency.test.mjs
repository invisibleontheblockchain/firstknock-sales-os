import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { findPolygonSelfIntersection } from '../base44/shared/precisionOrderSafety.js';

const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
    .replace(/^import .*;\s*$/gm, '');
const polygon = [{ lat: 33, lng: -113 }, { lat: 34, lng: -113 }, { lat: 34, lng: -112 }, { lat: 33, lng: -112 }];
const job = {
    created_date: '2026-10-06T12:00:00Z', sold_months: 1,
    polygon, estimated_record_count: 50,
    dry_run_metadata: { count_mode: 'max_available', filters: { min_price: 100000, max_price: 500000 } }
};
function property(index, overrides = {}) {
    return {
        address: { street: `${index + 100} Test St`, zip: '85001', latitude: 33.5, longitude: -112.5 },
        intel: { lastSoldDate: '2026-10-01', lastSoldPrice: 200000 },
        general: { standardizedLandUseCode: 'R2', propertyTypeDetail: 'Single Family' },
        ...overrides
    };
}
function load(fetch) {
    const context = { console, setTimeout, clearTimeout, AbortController, fetch, findPolygonSelfIntersection,
        Deno: { env: { get: () => null }, serve: () => {} } };
    vm.runInNewContext(source, context, { filename: 'processFetchChunk/entry.ts' });
    return context;
}
const plain = value => JSON.parse(JSON.stringify(value));

function provider(rows, { reportTotal = true, shortAt = null } = {}) {
    const calls = [];
    const fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request.options);
        const { skip, take } = request.options;
        const list = rows.slice(skip, skip + (skip === shortAt ? Math.min(20, take) : take));
        const payload = { results: { properties: list,
            ...(reportTotal ? { meta: { results: { resultsFound: rows.length } } } : {}) } };
        return { ok: true, text: async () => JSON.stringify(payload) };
    };
    return { calls, fetch };
}

test('50-home Max Available buys 50 records rather than a 500-record wave', async () => {
    const mock = provider(Array.from({ length: 1000 }, (_, i) => property(i)));
    const result = await load(mock.fetch).fetchBatchDataRecords(job);
    assert.deepEqual(mock.calls, [{ skip: 0, take: 50 }]);
    assert.equal(result.records.length, 50);
    assert.equal(result.attempts[0].reviewed, 50);
    assert.equal(result.attempts[0].next_skip, 50);
});

test('rejected rows trigger only the remaining shortfall and offsets stay contiguous', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => property(i, i < 15 ? {
        intel: { lastSoldDate: '2026-10-01', lastSoldPrice: 50000 }
    } : {}));
    const mock = provider(rows);
    const result = await load(mock.fetch).fetchBatchDataRecords(job);
    assert.deepEqual(mock.calls, [{ skip: 0, take: 50 }, { skip: 50, take: 15 }]);
    assert.equal(result.records.length, 50);
    assert.equal(result.attempts[0].reviewed, 65);
    assert.equal(result.attempts[0].route_outcomes.rejected_price, 15);
    assert.equal(result.attempts[0].next_skip, 65);
});

test('saved-route exclusions and provider duplicates count as loss and request a shortfall', async () => {
    const api = load();
    const excluded = api.mapBatchDataProperty(property(0), job).address_hash;
    const mock = provider([property(0), property(1), property(1), ...Array.from({ length: 100 }, (_, i) => property(i + 2))]);
    const result = await load(mock.fetch).fetchBatchDataRecords({ ...job,
        dry_run_metadata: { ...job.dry_run_metadata, excluded_route_hashes: [excluded] } });
    assert.deepEqual(mock.calls, [{ skip: 0, take: 50 }, { skip: 50, take: 2 }]);
    assert.equal(result.records.length, 50);
    assert.equal(result.attempts[0].skipped_existing_route, 1);
    assert.equal(result.attempts[0].skipped_duplicate, 1);
});

test('large drains retain concurrent pages, stop at known totals, and lose no chunk surplus', async () => {
    const mock = provider(Array.from({ length: 688 }, (_, i) => property(i)));
    const result = await load(mock.fetch).fetchBatchDataRecordsForMode(job, 'broad_polygon', 2500);
    assert.equal(result.reviewed, 688);
    assert.equal(result.records.length, 688);
    assert.equal(result.next_skip, 688);
    assert.equal(result.provider_exhausted, true);
    assert.deepEqual(mock.calls.slice(5), [{ skip: 500, take: 100 }, { skip: 600, take: 88 }]);
});

test('a draining chunk retains every purchased eligible record and resumes at the exact offset', async () => {
    const mock = provider(Array.from({ length: 3000 }, (_, i) => property(i)));
    const api = load(mock.fetch);
    const first = await api.fetchBatchDataRecordsForMode(job, 'broad_polygon', 743);
    assert.equal(first.reviewed, 743);
    assert.equal(first.active, 743);
    assert.equal(first.records.length, 743);
    const second = await api.fetchBatchDataRecordsForMode(job, 'broad_polygon', 50, null, first.next_skip);
    assert.equal(mock.calls.at(-1).skip, 743);
    assert.equal(second.records.length, 50);
    assert.equal(new Set([...first.records, ...second.records].map(p => p.address.street)).size, 793);
});

test('a short page without a reported total does not end Max Available before an empty page', async () => {
    const mock = provider(Array.from({ length: 180 }, (_, i) => property(i)), { reportTotal: false, shortAt: 0 });
    const result = await load(mock.fetch).fetchBatchDataRecordsForMode(job, 'broad_polygon', 1000);
    assert.equal(result.provider_exhausted, true);
    assert.equal(result.reviewed, 100);
    assert.equal(result.records.length, 100);
    assert.ok(mock.calls.some(call => call.skip >= 200));
});

test('a full custom-window drain crosses the chunk boundary and retains every eligible paid record', async () => {
    const rows = Array.from({ length: 3300 }, (_, i) => property(i, {
        intel: { lastSoldDate: '2026-08-15', lastSoldPrice: 200000 }
    }));
    const mock = provider(rows, { reportTotal: false });
    const requests = [];
    const api = load(async (url, options) => {
        requests.push(JSON.parse(options.body));
        return mock.fetch(url, options);
    });
    const customJob = { ...job, dry_run_metadata: { ...job.dry_run_metadata,
        drain_until_exhausted: true, ownership_range_mode: 'custom',
        ownership_range_days: { min: 30, max: 90 } } };
    const delivered = [];
    let offset = 0;
    let returned = 0;
    let chunks = 0;
    for (;;) {
        const chunk = await api.fetchBatchDataRecords(customJob, null, { requested: 2500, startSkip: offset });
        const attempt = chunk.attempts[0];
        delivered.push(...chunk.records);
        returned += attempt.reviewed;
        chunks++;
        if (attempt.provider_exhausted) break;
        assert.ok(attempt.next_skip > offset);
        offset = attempt.next_skip;
        assert.ok(chunks < 10, 'drain must make bounded progress');
    }
    assert.equal(chunks, 2);
    assert.equal(returned, 3300);
    assert.equal(delivered.length, 3300);
    assert.equal(new Set(delivered.map(row => row.address.street)).size, 3300);
    assert.equal(api.drainsUntilExhausted(customJob), true);
    for (const request of requests) {
        assert.deepEqual(request.searchCriteria.intel.lastSoldDate, {
            minDate: '2026-07-08', maxDate: '2026-09-06'
        });
        assert.deepEqual(request.searchCriteria.address.geoLocationPolygon.geoPoints,
            polygon.concat(polygon[0]).map(point => ({ latitude: point.lat, longitude: point.lng })));
    }
});

test('support-provided type criteria and both existing price fields are sent without dataset scoping', () => {
    const request = plain(load().buildBatchDataRequest(job, 0, 100));
    assert.deepEqual(request.searchCriteria.general.propertyTypeDetail.inList,
        ['Single Family', 'Single Family Residential (Assumed)']);
    assert.deepEqual(request.searchCriteria.general.standardizedLandUseCode, { equals: 'R2' });
    assert.deepEqual(request.searchCriteria.intel.lastSoldPrice, { min: 100000, max: 500000 });
    assert.deepEqual(request.searchCriteria.valuation.estimatedValue, { min: 100000, max: 500000 });
    assert.equal(Object.hasOwn(request.options, 'datasets'), false);
});

test('tax assessment and asking price cannot replace the price fields filtered upstream', () => {
    const api = load();
    const mapped = api.mapBatchDataProperty(property(0, {
        intel: { lastSoldDate: '2026-10-01', lastSoldPrice: 125000 },
        assessment: { assessedValue: 80000 }, listing: { price: 750000 }
    }), job);
    assert.equal(mapped.price, 125000);
    assert.equal(mapped.route_active, true);
    const badSale = api.mapBatchDataProperty(property(1, {
        intel: { lastSoldDate: '2026-10-01', lastSoldPrice: 50000 }, assessment: { assessedValue: 200000 }
    }), job);
    assert.equal(badSale.route_active, false);
    const badAvm = api.mapBatchDataProperty(property(2, { valuation: { estimatedValue: 600000 } }), job);
    assert.equal(badAvm.route_active, false);
});

test('geometry, custom ownership window, and detached property checks still exclude unusable records', () => {
    const api = load();
    assert.equal(api.mapBatchDataProperty(property(0, {
        address: { street: '100 Outside St', zip: '85001', latitude: 40, longitude: -112.5 }
    }), job), null);
    assert.equal(api.mapBatchDataProperty(property(1, {
        general: { standardizedLandUseCode: 'R2', propertyTypeDetail: 'Townhouse' }
    }), job).route_active, false);
    const custom = { ...job, dry_run_metadata: { ...job.dry_run_metadata,
        ownership_range_mode: 'custom', ownership_range_days: { min: 30, max: 90 } } };
    assert.equal(api.mapBatchDataProperty(property(2), custom).route_active, false);
});

test('credit efficiency accounts for a 1000-to-700 gap and accumulates across chunks', () => {
    const api = load();
    const first = api.buildCreditEfficiency(null, {
        route_outcomes: { rejected_price: 100, mapped_route_active_before_selection: 400 },
        final_selected_records: 400
    }, 500, 400);
    const final = plain(api.buildCreditEfficiency(first, {
        route_outcomes: { rejected_price: 100, rejected_property_type: 50, mapped_route_active_before_selection: 350 },
        skipped_existing_route: 50, final_selected_records: 300
    }, 1000, 700));
    assert.equal(final.provider_records_returned, 1000);
    assert.equal(final.persisted_route_active_records, 700);
    assert.equal(final.records_not_delivered, 300);
    assert.equal(final.loss_percent, 30);
    assert.equal(final.loss_breakdown.price, 200);
    assert.equal(final.loss_breakdown.already_in_saved_route, 50);
    assert.equal(final.loss_breakdown.property_type, 50);
    assert.equal(final.unclassified_records, 0);
});

test('the September 29 surplus is exposed, rather than disappearing from rejection counters', () => {
    const efficiency = load().buildCreditEfficiency(null, {
        route_outcomes: { mapped_route_active_before_selection: 421, rejected_price: 79 },
        final_selected_records: 50
    }, 500, 50);
    assert.equal(efficiency.loss_breakdown.selection_surplus, 371);
    assert.equal(efficiency.loss_percent, 90);
    assert.equal(efficiency.unclassified_records, 0);
});

test('provider zero totals are conserved and an unknown total remains unknown', () => {
    const api = load();
    assert.equal(api.extractBatchDataTotal({ results: { meta: { results: { resultsFound: 0 } } } }), 0);
    assert.equal(api.extractBatchDataTotal({}), null);
    assert.deepEqual(plain(api.planBatchDataWave(10, 50, 10)), []);
});

test('failed pages preserve successful paid pages and recover only failed offsets', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => property(i));
    const mock = provider(rows);
    const failures = new Set([100, 300]);
    const requests = [];
    const api = load(async (url, options) => {
        const request = JSON.parse(options.body).options;
        requests.push(request);
        if (failures.delete(request.skip)) return { ok: false, status: 400, text: async () => 'temporary test failure' };
        return mock.fetch(url, options);
    });
    const first = await api.fetchBatchDataRecordsForMode(job, 'broad_polygon', 500);
    assert.equal(first.records.length, 300);
    assert.equal(first.reviewed, 300);
    assert.equal(first.next_skip, 500);
    assert.equal(first.provider_exhausted, false);
    assert.deepEqual(plain(first.pending_pages), [{ pageSkip: 100, take: 100 }, { pageSkip: 300, take: 100 }]);
    const retryJob = { ...job, dry_run_metadata: { ...job.dry_run_metadata,
        pending_batchdata_pages: first.pending_pages, batchdata_provider_end_reached: first.provider_end_reached } };
    const retry = await api.fetchBatchDataRecordsForMode(retryJob, 'broad_polygon', 200, null, first.next_skip);
    assert.deepEqual(requests.slice(5), [{ skip: 100, take: 100 }, { skip: 300, take: 100 }]);
    assert.equal(retry.reviewed, 200);
    assert.equal(retry.next_skip, 500);
    assert.equal(retry.pending_pages.length, 0);
    const all = [...first.records, ...retry.records];
    assert.equal(new Set(all.map(row => row.address.street)).size, 500);
});

test('an empty end page does not complete a drain with an outstanding failed page', async () => {
    const mock = provider(Array.from({ length: 350 }, (_, i) => property(i)), { reportTotal: false });
    let failed = false;
    const api = load(async (url, options) => {
        if (!failed && JSON.parse(options.body).options.skip === 100) {
            failed = true;
            return { ok: false, status: 400, text: async () => 'test failure' };
        }
        return mock.fetch(url, options);
    });
    const first = await api.fetchBatchDataRecordsForMode(job, 'broad_polygon', 1000);
    assert.equal(first.records.length, 250);
    assert.equal(first.provider_end_reached, true);
    assert.equal(first.provider_exhausted, false);
    const retryJob = { ...job, dry_run_metadata: { ...job.dry_run_metadata,
        pending_batchdata_pages: first.pending_pages, batchdata_provider_end_reached: true } };
    const retry = await api.fetchBatchDataRecordsForMode(retryJob, 'broad_polygon', 750, null, first.next_skip);
    assert.equal(retry.records.length, 100);
    assert.equal(retry.provider_exhausted, true);
    assert.equal(retry.next_skip, 500);
    assert.equal(first.reviewed + retry.reviewed, 350);
});

test('invalid recovery checkpoints fail before any provider request', async () => {
    let calls = 0;
    const api = load(() => { calls++; throw new Error('must not fetch'); });
    for (const pages of [
        [{ pageSkip: 100, take: 101 }],
        [{ pageSkip: 200, take: 100 }],
        [{ pageSkip: 0, take: 100 }, { pageSkip: 0, take: 100 }],
        [{ pageSkip: 0, take: 100 }, { pageSkip: 100, take: 100 }]
    ]) {
        await assert.rejects(api.fetchBatchDataRecordsForMode({ ...job,
            dry_run_metadata: { ...job.dry_run_metadata, pending_batchdata_pages: pages }
        }, 'broad_polygon', 150, null, 200), /Invalid pending/);
    }
    assert.equal(calls, 0);
});
