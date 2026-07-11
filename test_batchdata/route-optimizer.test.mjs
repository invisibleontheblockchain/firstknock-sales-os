import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';


const bundleDir = await mkdtemp(path.join(tmpdir(), 'firstknock-route-test-'));
const bundlePath = path.join(bundleDir, 'routeOptimizer.mjs');
const territoryBundlePath = path.join(bundleDir, 'territoryLogic.mjs');
await build({
    entryPoints: [path.resolve('src/components/logic/routeOptimizer.jsx')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent'
});
await build({
    entryPoints: [path.resolve('src/components/logic/territoryLogic.jsx')],
    outfile: territoryBundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent'
});
const { generateOptimizedRoutes } = await import(pathToFileURL(bundlePath).href);
const { determineEffectiveStatus } = await import(pathToFileURL(territoryBundlePath).href);


test.after(async () => {
    await rm(bundleDir, { recursive: true, force: true });
});


function properties(count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `property-${index}`,
        address_hash: `hash-${index}`,
        house_number: 100 + index,
        street_name: `${Math.floor(index / 5) + 1} Main St`,
        zip_code: '85001',
        lat: 33.45 + ((index % 5) * 0.0008),
        lng: -112.07 + (Math.floor(index / 5) * 0.001),
        effective_status: 'ELIGIBLE',
        data_source: 'batchdata',
        sale_confidence: index % 2 === 0 ? 'verified' : 'medium',
        property_type: index % 2 === 0 ? 'Single Family' : 'Single Family (Unverified)',
        sold_date: '2026-06-01'
    }));
}


test('splits one drawn territory into rep-sized routes without losing or duplicating stops', () => {
    const routes = generateOptimizedRoutes(properties(23), 10, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: true,
        excludeTerminal: false
    });
    assert.equal(routes.length, 3);
    assert.deepEqual(routes.map(route => route.houseCount).sort((a, b) => b - a), [10, 10, 3]);
    const stopIds = routes.flatMap(route => route.properties.map(property => property.id));
    assert.equal(stopIds.length, 23);
    assert.equal(new Set(stopIds).size, 23);
});


test('honors the non-street-sweep routing option while preserving route size', () => {
    const routes = generateOptimizedRoutes(properties(12), 6, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: false,
        minimizeTurns: true,
        use2Opt: true,
        excludeTerminal: false
    });
    assert.equal(routes.length, 2);
    assert.deepEqual(routes.map(route => route.houseCount), [6, 6]);
});

test('an exact Precision job overrides mutable Canvas local storage mode', () => {
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => 'canvas' };
    try {
        const routes = generateOptimizedRoutes(properties(3), 10, null, [], {
            streetCooldownDays: 0,
            useStreetSweep: false,
            excludeTerminal: false,
            routeMode: 'precision'
        });
        assert.ok(routes.length > 0);
        assert.ok(routes.every(route => route.route_mode === 'precision'));
    } finally {
        if (originalLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = originalLocalStorage;
    }
});

test('keeps the all-in-one 10000-stop setting instead of silently capping routes at 500', () => {
    const routes = generateOptimizedRoutes(properties(501), 10000, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: true,
        use2Opt: false,
        excludeTerminal: false
    });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].houseCount, 501);
});

test('splits on max distance without losing or duplicating any stops', () => {
    const input = properties(18);
    const routes = generateOptimizedRoutes(input, 18, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: false,
        minimizeTurns: false,
        use2Opt: false,
        maxRouteDistance: 0.12,
        excludeTerminal: false
    });
    const stopIds = routes.flatMap(route => route.properties.map(property => property.id));
    assert.equal(stopIds.length, input.length);
    assert.equal(new Set(stopIds).size, input.length);
    assert.ok(routes.length > 1);
});

test('front-loads verified BatchData stops when the distance guard permits it', () => {
    const input = properties(30).map((property, index) => ({
        ...property,
        lat: 33.45,
        lng: -112.07,
        sale_confidence: index === 29 ? 'verified' : 'medium',
        property_type: index === 29 ? 'Single Family' : 'Unknown Residential Type (Unverified)'
    }));
    const routes = generateOptimizedRoutes(input, 30, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: false,
        minimizeTurns: false,
        use2Opt: false,
        excludeTerminal: false
    });
    const verifiedIndex = routes[0].properties.findIndex(property => property.id === 'property-29');
    assert.ok(verifiedIndex >= 0 && verifiedIndex < 22);
});

test('normalizes numeric-string coordinates instead of silently dropping those stops', () => {
    const input = properties(4).map(property => ({
        ...property,
        lat: String(property.lat),
        lng: String(property.lng)
    }));
    const routes = generateOptimizedRoutes(input, 4, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: true,
        excludeTerminal: false
    });
    assert.equal(routes.flatMap(route => route.properties).length, 4);
    assert.ok(routes.flatMap(route => route.properties).every(property => (
        typeof property.lat === 'number' && typeof property.lng === 'number'
    )));
});

test('does not collapse unrelated properties when normalized address components are incomplete', () => {
    const input = properties(2).map((property, index) => ({
        ...property,
        address_hash: `incomplete-${index}`,
        house_number: 0,
        street_name: '',
        full_address: `${100 + index} Unparsed Address, Phoenix, AZ 85001`
    }));
    const routes = generateOptimizedRoutes(input, 10, null, [], {
        streetCooldownDays: 0,
        useStreetSweep: false,
        use2Opt: false,
        excludeTerminal: false
    });
    assert.deepEqual(
        routes.flatMap(route => route.properties.map(property => property.address_hash)).sort(),
        ['incomplete-0', 'incomplete-1']
    );
});

test('scopes street cooldown by normalized street and locality while callbacks and qualified leads bypass it', () => {
    const now = new Date().toISOString();
    const input = [
        { ...properties(1)[0], id: 'logged', address_hash: 'logged', house_number: 100, street_name: 'Main Street', city: 'Phoenix', state: 'AZ', zip_code: '85001' },
        { ...properties(1)[0], id: 'neighbor', address_hash: 'neighbor', house_number: 102, street_name: 'MAIN ST.', city: 'Phoenix', state: 'AZ', zip_code: '85001' },
        { ...properties(1)[0], id: 'other-city', address_hash: 'other-city', house_number: 104, street_name: 'Main St', city: 'Tucson', state: 'AZ', zip_code: '85701' },
        { ...properties(1)[0], id: 'callback', address_hash: 'callback', house_number: 106, street_name: 'Main St', city: 'Phoenix', state: 'AZ', zip_code: '85001', effective_status: 'CALLBACK' },
        { ...properties(1)[0], id: 'qualified', address_hash: 'qualified', house_number: 108, street_name: 'Main St', city: 'Phoenix', state: 'AZ', zip_code: '85001', effective_status: 'QUALIFIED' }
    ];
    const routes = generateOptimizedRoutes(input, 10, null, [
        { address_hash: 'logged', parsed_status: 'NO_ANSWER', created_date: now }
    ], {
        streetCooldownDays: 30,
        useStreetSweep: false,
        use2Opt: false,
        excludeTerminal: false
    });
    const ids = new Set(routes.flatMap(route => route.properties.map(property => property.id)));
    assert.equal(ids.has('logged'), false);
    assert.equal(ids.has('neighbor'), false);
    assert.equal(ids.has('other-city'), true);
    assert.equal(ids.has('callback'), true);
    assert.equal(ids.has('qualified'), true);
});

test('explicitly re-included unresolved hashes bypass street cooldown without reopening the whole street', () => {
    const input = [
        { ...properties(1)[0], id: 'follow-up', address_hash: 'follow-up', house_number: 100, street_name: 'Main St', city: 'Phoenix', state: 'AZ', zip_code: '85001', effective_status: 'NO_ANSWER' },
        { ...properties(1)[0], id: 'neighbor', address_hash: 'neighbor', house_number: 102, street_name: 'Main St', city: 'Phoenix', state: 'AZ', zip_code: '85001' }
    ];
    const routes = generateOptimizedRoutes(input, 10, null, [
        { address_hash: 'follow-up', parsed_status: 'NO_ANSWER', created_date: new Date().toISOString() }
    ], {
        streetCooldownDays: 30,
        useStreetSweep: false,
        use2Opt: false,
        excludeTerminal: false,
        cooldownBypassHashes: new Set(['follow-up'])
    });
    const ids = new Set(routes.flatMap(route => route.properties.map(property => property.id)));
    assert.equal(ids.has('follow-up'), true);
    assert.equal(ids.has('neighbor'), false);
});

test('street cooldown set to zero bypasses both interaction and CSV cooldowns', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const input = properties(2).map((property, index) => ({
        ...property,
        id: `cooldown-off-${index}`,
        address_hash: `cooldown-off-${index}`,
        street_name: 'Cooldown Street',
        city: 'Phoenix',
        state: 'AZ',
        zip_code: '85001',
        street_next_eligible_date: future
    }));
    const routes = generateOptimizedRoutes(input, 10, null, [
        { address_hash: 'cooldown-off-0', parsed_status: 'NO_ANSWER', created_date: new Date().toISOString() }
    ], {
        streetCooldownDays: 0,
        useStreetSweep: false,
        use2Opt: false,
        excludeTerminal: false
    });
    assert.equal(routes.flatMap(route => route.properties).length, 2);
});

test('reopens only newly sold properties when the latest street interaction predates their ownership event', () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const input = [
        { ...properties(1)[0], id: 'logged-old-owner', address_hash: 'logged-old-owner', sold_date: null, house_number: 100, street_name: 'Ownership Ave', city: 'Phoenix', state: 'AZ', zip_code: '85001' },
        { ...properties(1)[0], id: 'ordinary-neighbor', address_hash: 'ordinary-neighbor', sold_date: null, house_number: 102, street_name: 'Ownership Ave', city: 'Phoenix', state: 'AZ', zip_code: '85001' },
        {
            ...properties(1)[0],
            id: 'new-owner',
            address_hash: 'new-owner',
            sold_date: null,
            house_number: 104,
            street_name: 'Ownership Ave',
            city: 'Phoenix',
            state: 'AZ',
            zip_code: '85001',
            provider_exact_sale_date_observed: false,
            provider_recent_sale_min_date: today,
            provider_recent_sale_sources: ['intel', 'sale']
        }
    ];
    const routes = generateOptimizedRoutes(input, 10, null, [
        { address_hash: 'logged-old-owner', parsed_status: 'NO_ANSWER', created_date: yesterday }
    ], {
        streetCooldownDays: 30,
        useStreetSweep: false,
        use2Opt: false,
        excludeTerminal: false
    });
    assert.deepEqual(routes.flatMap(route => route.properties.map(property => property.id)), ['new-owner']);
    assert.equal(routes._cooldownInfo.propertiesExcluded, 2);
    assert.equal(routes._cooldownInfo.propertiesReincludedForNewSale, 1);
});

test('keeps same-day street interactions in force when sale ordering is unknown', () => {
    const today = new Date().toISOString().slice(0, 10);
    const input = [{
        ...properties(1)[0],
        id: 'same-day-owner',
        address_hash: 'same-day-owner',
        sold_date: null,
        street_name: 'Same Day Rd',
        city: 'Phoenix',
        state: 'AZ',
        zip_code: '85001',
        provider_exact_sale_date_observed: false,
        provider_recent_sale_min_date: today
    }];
    const routes = generateOptimizedRoutes(input, 10, null, [
        { address_hash: 'same-day-owner', parsed_status: 'NO_ANSWER', created_date: new Date().toISOString() }
    ], {
        streetCooldownDays: 30,
        useStreetSweep: false,
        use2Opt: false,
        excludeTerminal: false
    });
    assert.equal(routes.length, 0);
    assert.equal(routes._cooldownInfo.propertiesExcluded, 1);
    assert.equal(routes._cooldownInfo.propertiesReincludedForNewSale, 0);
});

test('effective status ignores only interactions proven to predate the current sale event', () => {
    const today = new Date().toISOString().slice(0, 10);
    const currentProperty = {
        original_status: 'BATCHDATA_CANDIDATE',
        provider_exact_sale_date_observed: false,
        provider_recent_sale_min_date: today,
        provider_recent_sale_sources: ['intel']
    };
    const priorDayLog = {
        parsed_status: 'HARD_NO',
        created_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    };
    const sameDayLog = {
        parsed_status: 'HARD_NO',
        created_date: new Date().toISOString()
    };
    assert.equal(determineEffectiveStatus(currentProperty, [priorDayLog]), 'ELIGIBLE');
    assert.equal(determineEffectiveStatus(currentProperty, [sameDayLog]), 'HARD_NO');
    assert.equal(determineEffectiveStatus({ ...currentProperty, provider_recent_sale_sources: [] }, [priorDayLog]), 'HARD_NO');
});
