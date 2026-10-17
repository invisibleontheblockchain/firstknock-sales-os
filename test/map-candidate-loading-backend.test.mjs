import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../base44/functions/getRouteCandidatesFromNeon/entry.ts', import.meta.url), 'utf8');
function handlerFor({ user = { email: 'manager@example.com', role: 'user' }, rows = [] } = {}) {
    let handler;
    const queries = [];
    const sql = async (strings, ...parameters) => {
        const text = strings.join('?');
        queries.push({ text, parameters });
        return rows;
    };
    const executable = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(executable, {
        Response, Request, console, neon: () => sql,
        createClientFromRequest: () => ({ auth: { me: async () => user } }),
        Deno: { env: { get: () => 'test-db' }, serve: value => { handler = value; } },
    });
    return {
        queries,
        run: async body => {
            const response = await handler(new Request('https://example.test/candidates', {
                method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
            }));
            return { status: response.status, data: await response.json() };
        },
    };
}

test('map requests keep tenant/ZIP/status filters and limit narrow keys before payload projection', async () => {
    const harness = handlerFor({ rows: [{ id: 123, address_hash: 'door', full_address: '1010 Main St', lat: 33.4, lng: -112.1 }] });
    const response = await harness.run({ zip_codes: ['85001'], sold_months: 'all', fields: 'map', limit: 1000, user_email: 'victim@example.com' });
    assert.equal(response.status, 200);
    assert.equal(response.data.properties[0].full_address, '1010 Main St');
    assert.equal(response.data.properties[0].id, '123');
    const query = harness.queries[0];
    assert.equal(query.parameters[0], 'manager@example.com');
    assert.equal(query.parameters.includes('victim@example.com'), false);
    const limited = query.text.indexOf('LIMIT ?');
    assert.ok(limited > query.text.indexOf('WHERE wp.user_email = ?'));
    assert.ok(limited < query.text.indexOf("p.raw_payload -> 'property'"));
    assert.match(query.text, /WITH candidate_keys AS MATERIALIZED/);
    assert.match(query.text, /FROM candidate_keys wp\s+JOIN properties p/);
    assert.match(query.text, /COALESCE\(wp.status, ''\) <> 'REJECTED'/);
    assert.match(query.text, /p.zip_code = ANY\(\?\)/);
});

test('map requests only serialize the whole property row when a subdivision_name column exists', async () => {
    const harness = handlerFor({ rows: [] });
    await harness.run({ sold_months: 'all', fields: 'map', limit: 20000 });
    const query = harness.queries[0];
    assert.match(query.text, /\), subdivision_column AS \(\s*SELECT EXISTS \(\s*SELECT 1 FROM pg_attribute\s+WHERE attrelid = 'properties'::regclass\s+AND attname = 'subdivision_name'/);
    assert.match(query.text, /p\.raw_payload ->> 'subdivisionName',\s*CASE WHEN \(SELECT present FROM subdivision_column\) THEN to_jsonb\(p\) ->> 'subdivision_name' END\s*\) AS subdivision_name/);
});

test('analytics summary returns totals and only matching lightweight doors without raw payload work', async () => {
    const properties = [{ id: '1', address_hash: 'door', original_status: 'ELIGIBLE', lat: 33.4, lng: -112.1 }];
    const status_counts = { ELIGIBLE: 1999, HARD_NO: 1, DO_NOT_KNOCK: 0, UNVERIFIED: 0 };
    const harness = handlerFor({ rows: [{ count: 2000, candidate_count: 2000, status_counts, properties }] });
    const response = await harness.run({ response_mode: 'analytics_summary', analytics_hashes: ['door'], zip_codes: ['85001'], sold_months: 'all', limit: 100000 });
    assert.equal(response.status, 200);
    assert.equal(response.data.count, 2000);
    assert.equal(response.data.response_mode, 'analytics_summary');
    assert.deepEqual(response.data.status_counts, status_counts);
    assert.deepEqual(response.data.properties, properties);
    assert.equal(response.data.capped, false);
    const query = harness.queries[0];
    assert.doesNotMatch(query.text, /raw_payload|to_jsonb\(p\)|owner_full_name|subdivision_name/);
    assert.match(query.text, /COUNT\(DISTINCT id\)/);
    assert.match(query.text, /WHERE address_hash = ANY\(\?\)/);
    assert.match(query.text, /WHERE lat <> 0 AND lng <> 0/);
    assert.deepEqual([...query.parameters.at(-1)], ['door']);
});

test('analytics summary rejects oversized or malformed hash batches before querying', async () => {
    for (const hashes of [Array.from({ length: 5001 }, (_, i) => `door-${i}`), { hash: 'door' }, ['x'.repeat(257)], [42]]) {
        const harness = handlerFor();
        const response = await harness.run({ response_mode: 'analytics_summary', analytics_hashes: hashes });
        assert.equal(response.status, 400);
        assert.equal(harness.queries.length, 0);
    }
});

test('unauthenticated metadata requests cannot reach the property store', async () => {
    const harness = handlerFor({ user: null });
    const response = await harness.run({ response_mode: 'analytics_summary', analytics_hashes: ['door'] });
    assert.equal(response.status, 401);
    assert.equal(harness.queries.length, 0);
});

test('summary and row modes bind the same authorized candidate filter values', async () => {
    const body = { zip_codes: ['85001'], sold_months: 3, limit: 100000, bounds: { minLat: 33, maxLat: 34, minLng: -113, maxLng: -112 } };
    const full = handlerFor();
    const summary = handlerFor({ rows: [{ count: 0 }] });
    await full.run(body);
    await summary.run({ ...body, response_mode: 'analytics_summary', analytics_hashes: [] });
    // The aggregate only adds matching-hash parameters after the identical
    // tenant, ZIP, sold-window, custom-window, bounds and limit parameters.
    assert.deepEqual(JSON.parse(JSON.stringify(summary.queries[0].parameters.slice(0, -1))),
        JSON.parse(JSON.stringify(full.queries[0].parameters)));
});
