import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FUNCTION_PATH = 'base44/functions/processFetchChunk/entry.ts';
const HASH_ONE = '100 TEST AVE|85001';
const HASH_TWO = '200 TEST AVE|85001';

function batchDataRecord(street, price = 425_000, soldDate = '2026-06-01') {
    return {
        property: {
            address: {
                street,
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                location: {
                    latitude: 33.4484,
                    longitude: -112.074,
                },
            },
            general: {
                standardizedLandUseCode: 'R2',
                propertyTypeDetail: 'Single Family',
            },
            intel: {
                lastSoldDate: soldDate,
                lastSoldPrice: price,
            },
        },
    };
}

function makeHarness({
    actor = { id: 'admin-1', role: 'admin', email: 'admin@example.com' },
    route = {
        id: 'route-1',
        created_by: ' AustenWaugh@Gmail.com ',
        manager_id: 'manager-1',
        property_hashes: [HASH_ONE],
    },
    canonicalRows = [{
        id: 11,
        address_hash: HASH_ONE,
        price: 0,
        sold_date: null,
        original_status: 'BATCHDATA_CONFIRMED',
    }],
    lineageRows = [{ fetch_job_id: 'fetch-job-1' }],
    records = [batchDataRecord('100 Test Avenue')],
} = {}) {
    const job = {
        id: 'fetch-job-1',
        provider: 'batchdata',
        created_date: '2026-07-24T12:00:00.000Z',
        sold_months: 12,
        polygon: [
            { lat: 33.4, lng: -112.2 },
            { lat: 33.6, lng: -112.2 },
            { lat: 33.6, lng: -112.0 },
            { lat: 33.4, lng: -112.0 },
        ],
        dry_run_metadata: {
            filters: {
                min_price: 250_000,
                max_price: 750_000,
            },
        },
    };
    const sqlCalls = [];
    const fetchCalls = [];
    let handler;

    async function sql(strings, ...values) {
        const text = strings.join('?').replace(/\s+/g, ' ').trim();
        sqlCalls.push({ text, values });
        if (text.startsWith('SELECT p.id, p.address_hash')) return canonicalRows;
        if (text.startsWith('SELECT DISTINCT wp.fetch_job_id')) return lineageRows;
        if (text.startsWith('UPDATE properties')) return [{ id: values[4] }];
        if (text.startsWith('INSERT INTO workspace_properties')) {
            return [{ property_id: values[0] }];
        }
        throw new Error(`Unexpected SQL in processFetchChunk repair test: ${text}`);
    }

    const service = {
        entities: {
            SavedRoute: {
                get: async (id) => id === route.id ? route : null,
            },
            FetchJob: {
                get: async (id) => id === job.id ? job : null,
            },
            User: {
                get: async () => ({
                    id: 'manager-1',
                    email: 'austenwaugh@gmail.com',
                }),
            },
        },
    };
    const base44 = {
        auth: { me: async () => actor },
        asServiceRole: service,
    };
    const fetchMock = async (url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push({ url, options, body });
        return new Response(JSON.stringify({
            results: {
                properties: records,
                totalRecordCount: records.length,
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    const sandbox = {
        AbortController,
        Deno: {
            env: {
                get: (key) => ({
                    BATCH_DATA_API_KEY: 'test-token',
                    DATABASE_URL: 'postgres://test',
                })[key] || null,
            },
            serve: (candidate) => {
                handler = candidate;
            },
        },
        Response,
        clearTimeout,
        console,
        createClientFromRequest: () => base44,
        fetch: fetchMock,
        neon: () => sql,
        setTimeout,
    };
    const source = fs.readFileSync(FUNCTION_PATH, 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(source, sandbox, { filename: FUNCTION_PATH });

    return { fetchCalls, handler, sqlCalls };
}

async function invoke(handler, body) {
    const response = await handler({ json: async () => body });
    return { response, body: await response.json() };
}

test('processFetchChunk repair branch is admin-only and bypasses normal job processing', async () => {
    const harness = makeHarness({
        actor: { id: 'user-1', role: 'user', email: 'user@example.com' },
    });
    const result = await invoke(harness.handler, {
        repair_saved_route_metadata: true,
        route_id: 'route-1',
    });

    assert.equal(result.response.status, 403);
    assert.equal(result.body.error, 'forbidden');
    assert.equal(harness.sqlCalls.length, 0);
    assert.equal(harness.fetchCalls.length, 0);
});

test('processFetchChunk route repair dry-run scans the linked polygon without mutations', async () => {
    const harness = makeHarness();
    const result = await invoke(harness.handler, {
        repair_saved_route_metadata: true,
        route_id: 'route-1',
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.body.apply, false);
    assert.equal(result.body.counts.provider_pages, 1);
    assert.equal(result.body.counts.exact_matches, 1);
    assert.equal(result.body.counts.repairable, 1);
    assert.equal(result.body.counts.updated, 0);
    assert.equal(
        harness.sqlCalls.some(call => call.text.startsWith('UPDATE properties')),
        false
    );
    assert.equal(
        harness.sqlCalls.some(call => call.text.startsWith('INSERT INTO workspace_properties')),
        false
    );
    assert.equal(harness.fetchCalls.length, 1);
    const request = harness.fetchCalls[0].body;
    assert.equal(
        Object.prototype.hasOwnProperty.call(request.options, 'datasets'),
        false
    );
    assert.equal(request.options.take, 100);
    assert.equal(
        Object.prototype.hasOwnProperty.call(request.searchCriteria, 'query'),
        false
    );
    assert.equal(
        request.searchCriteria.address.geoLocationPolygon.geoPoints.length,
        5
    );
});

test('processFetchChunk apply updates only exact route hashes and preserves workspace status', async () => {
    const harness = makeHarness({
        route: {
            id: 'route-1',
            created_by: ' AustenWaugh@Gmail.com ',
            manager_id: 'manager-1',
            property_hashes: [HASH_ONE, HASH_TWO],
        },
        canonicalRows: [
            {
                id: 11,
                address_hash: HASH_ONE,
                price: 0,
                sold_date: null,
                original_status: 'BATCHDATA_CONFIRMED',
            },
            {
                id: 22,
                address_hash: HASH_TWO,
                price: null,
                sold_date: null,
                original_status: 'BATCHDATA_CONFIRMED',
            },
        ],
        records: [
            batchDataRecord('100 Test Avenue', 425_000, '2026-06-01'),
            batchDataRecord('999 Other Street', 999_999, '2026-06-02'),
        ],
    });
    const result = await invoke(harness.handler, {
        repair_saved_route_metadata: true,
        route_id: 'route-1',
        fetch_job_id: 'fetch-job-1',
        apply: true,
        max_properties: 100,
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.body.apply, true);
    assert.equal(result.body.counts.exact_matches, 1);
    assert.equal(result.body.counts.repairable, 1);
    assert.equal(result.body.counts.updated, 1);
    assert.equal(result.body.counts.unmatched, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'properties'), false);

    const updates = harness.sqlCalls.filter(call => call.text.startsWith('UPDATE properties'));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values[4], 11);
    assert.equal(updates[0].values[5], HASH_ONE);
    assert.match(
        updates[0].text,
        /price = CASE WHEN price IS NULL OR price <= 0 THEN \? ELSE price END/
    );
    assert.deepEqual(JSON.parse(updates[0].values[2]), {
        estimated_value: 425_000,
    });
    assert.deepEqual(JSON.parse(updates[0].values[3]), {
        date: '2026-06-01T00:00:00.000Z',
        amount: 425_000,
    });

    const links = harness.sqlCalls.filter(call => (
        call.text.startsWith('INSERT INTO workspace_properties')
    ));
    assert.equal(links.length, 1);
    assert.equal(links[0].values[0], 11);
    assert.equal(links[0].values[1], 'austenwaugh@gmail.com');
    assert.match(
        links[0].text,
        /ON CONFLICT \(property_id, user_email\) DO NOTHING/
    );
});

test('processFetchChunk repair rejects malformed provider sold dates', async () => {
    const harness = makeHarness({
        canonicalRows: [{
            id: 11,
            address_hash: HASH_ONE,
            price: 425_000,
            sold_date: null,
            original_status: 'BATCHDATA_CONFIRMED',
        }],
        records: [batchDataRecord('100 Test Avenue', 425_000, 'not-a-date')],
    });
    const result = await invoke(harness.handler, {
        repair_saved_route_metadata: true,
        route_id: 'route-1',
        apply: true,
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.body.counts.exact_matches, 1);
    assert.equal(result.body.counts.fully_matched, 0);
    assert.equal(result.body.counts.repairable, 0);
    assert.equal(
        harness.sqlCalls.some(call => call.text.startsWith('UPDATE properties')),
        false
    );
});
