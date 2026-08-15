import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
    filterBusinessOwnedProperties,
    getOwnerName,
    isBusinessOwnedProperty,
    looksLikeBusinessOwnerName,
} from '../src/components/logic/ownerType.js';

test('uses explicit provider business-ownership flags across supported payload shapes', () => {
    assert.equal(isBusinessOwnedProperty({ corporate_owned: true }), true);
    assert.equal(isBusinessOwnedProperty({ corporateOwned: 'yes' }), true);
    assert.equal(isBusinessOwnedProperty({ quickLists: { corporateOwned: 1 } }), true);
    assert.equal(isBusinessOwnedProperty({ quick_lists: { corporate_owned: 'true' } }), true);
    assert.equal(isBusinessOwnedProperty({ owner: { corporateOwned: true } }), true);
    assert.equal(isBusinessOwnedProperty({ corporate_owned: false, owner_full_name: 'Jane Smith' }), false);
});

test('falls back to narrow legal-entity name detection for older records', () => {
    for (const ownerName of [
        'Desert Ridge Homes LLC',
        'DESERT RIDGE HOMES, L.L.C.',
        'Vinx Property Group Inc.',
        'First Knock Corporation',
        'Sunset Holdings Limited',
    ]) {
        assert.equal(looksLikeBusinessOwnerName(ownerName), true, ownerName);
        assert.equal(isBusinessOwnedProperty({ owner_full_name: ownerName }), true, ownerName);
    }

    for (const ownerName of [
        'Jane Smith',
        'Smith Family Trust',
        'Incredible Family',
        'Corporal James Miller',
        '',
    ]) {
        assert.equal(looksLikeBusinessOwnerName(ownerName), false, ownerName);
        assert.equal(isBusinessOwnedProperty({ owner_full_name: ownerName }), false, ownerName);
    }
});

test('resolves legacy owner-name fields and filters only business-owned properties when enabled', () => {
    assert.equal(getOwnerName({ owner_name: 'Jane Smith' }), 'Jane Smith');
    assert.equal(getOwnerName({ ownerFullName: 'John Smith' }), 'John Smith');
    assert.equal(getOwnerName({ owner: { fullName: 'Acme LLC' } }), 'Acme LLC');
    assert.equal(getOwnerName({ owner: { names: [{ full: 'Legacy Homes LLC' }] } }), 'Legacy Homes LLC');

    const properties = [
        { id: 'person', owner_full_name: 'Jane Smith' },
        { id: 'flagged', corporate_owned: true, owner_full_name: 'Unknown' },
        { id: 'legacy-name', owner_name: 'Desert Ridge Homes LLC' },
        { id: 'trust', owner_full_name: 'Smith Family Trust' },
        { id: 'unknown' },
    ];

    assert.equal(filterBusinessOwnedProperties(properties, false), properties);
    assert.deepEqual(
        filterBusinessOwnedProperties(properties, true).map(property => property.id),
        ['person', 'trust', 'unknown']
    );
});

test('wires provider flags through persistence, route generation, and generated-route filtering', () => {
    const ingestion = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8');
    const candidates = fs.readFileSync('base44/functions/getRouteCandidatesFromNeon/entry.ts', 'utf8');
    const hydration = fs.readFileSync('base44/functions/getRoutePropertiesByHashes/entry.ts', 'utf8');
    const routePipeline = fs.readFileSync('src/components/logic/routeFilterPipeline.jsx', 'utf8');
    const builder = fs.readFileSync('src/components/map/RouteBuilderSettings.jsx', 'utf8');
    const checklist = fs.readFileSync('src/components/routes/RouteChecklist.jsx', 'utf8');

    assert.match(ingestion, /corporate_owned:\s*corporateOwned/);
    assert.match(ingestion, /INSERT INTO properties[\s\S]*corporate_owned/);
    assert.match(candidates, /p\.corporate_owned/);
    assert.ok((hydration.match(/to_jsonb\(p\) ->> 'corporate_owned'/g) || []).length >= 2);
    assert.match(hydration, /const canonicalAuthorizedHashes = missingWorkspaceHashes\.filter[\s\S]*FROM properties p/);
    assert.match(routePipeline, /routeConfig\.excludeBusinessOwned/);
    assert.match(routePipeline, /!isBusinessOwnedProperty\(p\)/);
    assert.match(builder, /Exclude LLC \/ Business-Owned/);
    assert.match(checklist, /Hide LLC \/ business-owned/);
    assert.match(checklist, /visibleRouteProperties/);
});

test('maps BatchData owner and quick-list flags into the persisted property shape', () => {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '');
    const sandbox = {
        Deno: {
            env: { get: () => null },
            serve: () => {},
        },
        console,
        precisionCriteriaReferenceMs: () => null,
        setTimeout,
        clearTimeout,
    };
    vm.runInNewContext(
        `${source}\nglobalThis.__mapBatchDataProperty = mapBatchDataProperty;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );

    const mapped = sandbox.__mapBatchDataProperty({
        property: {
            address: {
                street: '100 Test Ave',
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                location: { latitude: 33.4484, longitude: -112.074 },
            },
            owner: {
                fullName: 'Desert Ridge Homes LLC',
                ownerOccupied: false,
            },
            quickLists: {
                corporateOwned: true,
                investorOwned: 'yes',
            },
            intel: { lastSoldDate: new Date().toISOString().slice(0, 10) },
            general: {
                standardizedLandUseCode: 'R2',
                propertyTypeDetail: 'Single Family',
            },
        },
    }, {
        sold_months: 12,
        polygon: [
            { lat: 33.4, lng: -112.2 },
            { lat: 33.6, lng: -112.2 },
            { lat: 33.6, lng: -112.0 },
            { lat: 33.4, lng: -112.0 },
        ],
        dry_run_metadata: { filters: {} },
    });

    assert.equal(mapped.owner_full_name, 'Desert Ridge Homes LLC');
    assert.equal(mapped.owner_occupied, false);
    assert.equal(mapped.corporate_owned, true);
    assert.equal(mapped.investor_owned, true);
    assert.equal(mapped.route_active, true);

    const stale = sandbox.__mapBatchDataProperty({
        property: {
            address: {
                street: '200 Test Ave',
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                location: { latitude: 33.4484, longitude: -112.074 },
            },
            intel: { lastSoldDate: '2020-01-01' },
            general: {
                standardizedLandUseCode: 'R2',
                propertyTypeDetail: 'Single Family',
            },
        },
    }, {
        sold_months: 12,
        polygon: mapped ? [
            { lat: 33.4, lng: -112.2 },
            { lat: 33.6, lng: -112.2 },
            { lat: 33.6, lng: -112.0 },
            { lat: 33.4, lng: -112.0 },
        ] : [],
        dry_run_metadata: { filters: {} },
    });
    const missing = sandbox.__mapBatchDataProperty({
        property: {
            address: {
                street: '300 Test Ave',
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                location: { latitude: 33.4484, longitude: -112.074 },
            },
            general: {
                standardizedLandUseCode: 'R2',
                propertyTypeDetail: 'Single Family',
            },
        },
    }, {
        sold_months: 12,
        polygon: [
            { lat: 33.4, lng: -112.2 },
            { lat: 33.6, lng: -112.2 },
            { lat: 33.6, lng: -112.0 },
            { lat: 33.4, lng: -112.0 },
        ],
        dry_run_metadata: { filters: {} },
    });
    assert.equal(stale.route_active, false);
    assert.equal(missing.route_active, false);
});

test('explains that the range is based on recorded sale data, not occupant move-in', () => {
    const pullPanel = fs.readFileSync('src/components/map/PrecisionPullPanel.jsx', 'utf8');
    const builder = fs.readFileSync('src/components/map/RouteBuilderSettings.jsx', 'utf8');

    assert.match(pullPanel, /recorded sale\/transfer date/i);
    assert.match(pullPanel, /does not confirm when an occupant moved in/i);
    assert.match(builder, /not a confirmed occupant move-in date/i);
});
