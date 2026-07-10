import assert from 'node:assert/strict';
import test from 'node:test';

import { paginateArm } from './run-pipeline-house-comparison.mjs';

const MIN_DATE = '2026-06-26';
const MAX_DATE = '2026-07-09';

function propertyRecord(index) {
    return {
        property: {
            ids: { propertyId: `property-${index}` },
            address: {
                street: `${100 + index} Test St`,
                city: 'Seattle',
                state: 'WA',
                zip: '98101',
                location: { latitude: 47.6062, longitude: -122.3321 }
            }
        }
    };
}

function updatedArm() {
    return {
        key: 'updated_intel_test',
        method: 'updated',
        engine: 'updated',
        description: 'Offline pagination fixture',
        request: {
            searchCriteria: {},
            options: { skip: 0, take: 2, datasets: ['basic'] }
        }
    };
}

function countResult(providerTotal) {
    return {
        key: 'updated_intel_test',
        method: 'updated',
        engine: 'updated',
        description: 'Offline pagination fixture',
        ok: true,
        status: 200,
        provider_total: providerTotal,
        error: null
    };
}

function budget({ httpLimit = 20, recordLimit = 100 } = {}) {
    return { httpUsed: 0, httpLimit, recordUnits: 0, recordLimit };
}

function successfulResponse(records, providerTotal) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            results: { properties: records, totalRecordCount: providerTotal }
        })
    };
}

function pagedFetch(allRecords, { providerTotal = allRecords.length } = {}) {
    const calls = [];
    return {
        calls,
        fetchImpl: async (_url, options) => {
            const request = JSON.parse(options.body);
            const { skip, take } = request.options;
            calls.push({ skip, take });
            return successfulResponse(allRecords.slice(skip, skip + take), providerTotal);
        }
    };
}

function paginationOptions(fetchImpl, overrides = {}) {
    return {
        requested: 1000,
        pageSize: 2,
        maxPages: 20,
        minDate: MIN_DATE,
        maxDate: MAX_DATE,
        fetchImpl,
        wait: async () => {},
        ...overrides
    };
}

test('paginates through at least three pages and exhausts the provider stream', async () => {
    const records = Array.from({ length: 5 }, (_, index) => propertyRecord(index + 1));
    const mock = pagedFetch(records);
    const limits = budget();

    const result = await paginateArm(
        updatedArm(),
        countResult(records.length),
        limits,
        paginationOptions(mock.fetchImpl)
    );

    assert.deepEqual(mock.calls, [
        { skip: 0, take: 2 },
        { skip: 2, take: 2 },
        { skip: 4, take: 2 }
    ]);
    assert.equal(result.pages, 3);
    assert.equal(result.returned_count, 5);
    assert.equal(result.selected_routeable_count, 5);
    assert.equal(result.complete, true);
    assert.equal(result.completion_reason, 'short_final_page');
    assert.equal(limits.httpUsed, 3);
    assert.equal(limits.recordUnits, 5);
});

test('flags an upward provider-total drift while respecting the requested target', async () => {
    const records = Array.from({ length: 6 }, (_, index) => propertyRecord(index + 20));
    const mock = pagedFetch(records, { providerTotal: 6 });
    const limits = budget();

    const result = await paginateArm(
        updatedArm(),
        countResult(4),
        limits,
        paginationOptions(mock.fetchImpl, { requested: 4 })
    );

    assert.deepEqual(result.provider_totals_observed, [4, 6]);
    assert.equal(result.provider_total_drift, true);
    assert.equal(result.provider_total, 6);
    assert.equal(result.selected_routeable_count, 4);
    assert.equal(result.complete, false);
    assert.equal(result.native_complete, true);
    assert.equal(result.completion_reason, 'native_target_reached');
    assert.equal(mock.calls.length, 2);
});

test('detects and accounts for a provider repeating the same page', async () => {
    const repeated = [propertyRecord(40), propertyRecord(41)];
    const calls = [];
    const fetchImpl = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push({ skip: request.options.skip, take: request.options.take });
        return successfulResponse(repeated, 6);
    };
    const limits = budget();

    const result = await paginateArm(
        updatedArm(),
        countResult(6),
        limits,
        paginationOptions(fetchImpl)
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'pagination_repeat_detected');
    assert.equal(result.completion_reason, 'pagination_repeat_detected');
    assert.equal(result.complete, false);
    assert.equal(result.pages, 2);
    assert.equal(result.returned_count, 4);
    assert.equal(limits.httpUsed, 2);
    assert.equal(limits.recordUnits, 4);
    assert.deepEqual(calls, [{ skip: 0, take: 2 }, { skip: 2, take: 2 }]);
});

test('record ceiling shrinks the final request and prevents another page', async () => {
    const records = Array.from({ length: 9 }, (_, index) => propertyRecord(index + 60));
    const mock = pagedFetch(records);
    const limits = budget({ recordLimit: 5 });

    const result = await paginateArm(
        updatedArm(),
        countResult(records.length),
        limits,
        paginationOptions(mock.fetchImpl, { pageSize: 3, requested: 9 })
    );

    assert.deepEqual(mock.calls, [{ skip: 0, take: 3 }, { skip: 3, take: 2 }]);
    assert.equal(result.returned_count, 5);
    assert.equal(result.completion_reason, 'record_budget_exhausted');
    assert.equal(result.complete, false);
    assert.equal(result.native_complete, false);
    assert.equal(limits.recordUnits, 5);
    assert.equal(limits.httpUsed, 2);
});

test('HTTP ceiling prevents a request beyond the configured attempt limit', async () => {
    const records = Array.from({ length: 9 }, (_, index) => propertyRecord(index + 80));
    const mock = pagedFetch(records);
    const limits = budget({ httpLimit: 2 });

    await assert.rejects(
        paginateArm(
            updatedArm(),
            countResult(records.length),
            limits,
            paginationOptions(mock.fetchImpl, { requested: 9 })
        ),
        /Local HTTP budget exhausted before request/
    );

    assert.equal(mock.calls.length, 2);
    assert.equal(limits.httpUsed, 2);
    assert.equal(limits.recordUnits, 4);
});
