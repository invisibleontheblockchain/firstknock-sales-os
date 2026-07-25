import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const PROCESS_FETCH_CHUNK_PATH = 'base44/functions/processFetchChunk/entry.ts';

function loadProcessFetchChunkContracts() {
    const source = fs.readFileSync(PROCESS_FETCH_CHUNK_PATH, 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    const sandbox = {
        Deno: {
            env: { get: () => null },
            serve: () => {},
        },
        console,
        setTimeout,
        clearTimeout,
    };

    vm.runInNewContext(
        `${source}
globalThis.__buildBatchDataRequest = buildBatchDataRequest;
globalThis.__mapBatchDataProperty = mapBatchDataProperty;`,
        sandbox,
        { filename: PROCESS_FETCH_CHUNK_PATH }
    );

    return {
        buildBatchDataRequest: sandbox.__buildBatchDataRequest,
        mapBatchDataProperty: sandbox.__mapBatchDataProperty,
        source,
    };
}

const precisionJob = {
    id: 'precision-route-contract',
    user_email: ' AustenWaugh@Gmail.com ',
    created_date: '2026-07-24T12:00:00.000Z',
    sold_months: 12,
    polygon: [
        { lat: 33.4, lng: -112.2 },
        { lat: 33.6, lng: -112.2 },
        { lat: 33.6, lng: -112.0 },
        { lat: 33.4, lng: -112.0 },
    ],
    dry_run_metadata: { filters: {} },
};

function providerProperty(street, saleFields) {
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
            ...saleFields,
        },
    };
}

test('strict and broad BatchData requests omit dataset scoping and cap take at 100', () => {
    const { buildBatchDataRequest } = loadProcessFetchChunkContracts();

    for (const mode of ['strict_polygon', 'broad_polygon']) {
        const request = buildBatchDataRequest(precisionJob, 25, 5_000, mode);

        assert.equal(request.options.skip, 25, `${mode} should preserve the requested offset`);
        assert.equal(request.options.take, 100, `${mode} should honor BatchData's maximum page size`);
        assert.equal(
            Object.prototype.hasOwnProperty.call(request.options, 'datasets'),
            false,
            `${mode} must not suppress sale/intel evidence with a scoped datasets option`
        );
    }
});

test('BatchData intel and last-sale aliases hydrate canonical sold date and price', () => {
    const { mapBatchDataProperty } = loadProcessFetchChunkContracts();
    const examples = [
        {
            label: 'intel last-sold fields',
            record: providerProperty('100 Test Ave', {
                intel: {
                    lastSoldDate: '2026-06-01',
                    lastSoldPrice: 425_000,
                },
            }),
            soldDate: '2026-06-01',
            price: 425_000,
        },
        {
            label: 'lastSale sale fields',
            record: providerProperty('200 Test Ave', {
                lastSale: {
                    saleDate: '2026-05-15',
                    salePrice: 390_000,
                },
            }),
            soldDate: '2026-05-15',
            price: 390_000,
        },
    ];

    for (const example of examples) {
        const mapped = mapBatchDataProperty(example.record, precisionJob);
        assert.ok(mapped, `${example.label} should produce a route property`);
        assert.equal(mapped.sold_date, example.soldDate, `${example.label} should populate sold_date`);
        assert.equal(mapped.price, example.price, `${example.label} should populate price`);

        const auditPayload = JSON.parse(mapped.raw_payload);
        assert.equal(auditPayload.sale.date, example.soldDate);
        assert.equal(auditPayload.sale.amount, example.price);
    }
});

test('workspace property writes normalize email and integrity lookup is case-insensitive', () => {
    const { source } = loadProcessFetchChunkContracts();
    const normalizer = source.match(
        /function normalizeWorkspaceEmail\(value\)\s*\{[\s\S]*?\n\}/
    )?.[0] || '';

    assert.match(normalizer, /String\(value \|\| ''\)/);
    assert.match(normalizer, /\.trim\(\)/);
    assert.match(normalizer, /\.toLowerCase\(\)/);
    assert.ok(
        (source.match(/normalizeWorkspaceEmail\(job\.user_email\)/g) || []).length >= 2,
        'both persistence and integrity verification should normalize the job email'
    );

    const workspaceLinkWrites = [
        ...source.matchAll(
            /INSERT INTO workspace_properties \(property_id, user_email,[\s\S]*?ON CONFLICT \(property_id, user_email\)/g
        ),
    ];
    assert.equal(workspaceLinkWrites.length, 2, 'both workspace link write paths should be covered');
    for (const [index, match] of workspaceLinkWrites.entries()) {
        assert.match(
            match[0],
            /VALUES \(\$\{[^}]+\}, \$\{workspaceEmail\},/,
            `workspace link write ${index + 1} should use the normalized email`
        );
    }

    assert.match(
        source,
        /WHERE LOWER\(wp\.user_email\) = LOWER\(\$\{workspaceEmail\}\)/,
        'post-write integrity verification should not depend on email casing'
    );
});
