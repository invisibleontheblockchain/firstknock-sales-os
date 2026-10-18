import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as routeDisplayGeometry from '../base44/shared/routeDisplayGeometry.js';
import { isValidRoutePoint } from '../base44/shared/routeBounds.js';
import { OPTIMIZE_MODES, ROUTE_ORIGIN_MODES, resolveOptimizeMode, routeOriginModeForOptimizeMode } from '../src/lib/routeOriginModes.js';
import { hasCompleteRouteMapPoints } from '../src/components/logic/routeHydrationCore.js';
import { loadSavedRouteSelection } from '../src/components/logic/routeMapSelection.js';
import {
    MAP_ROUTE_FIELDS, MAP_ROUTE_METADATA_KEYS, MAP_ROUTE_OMITTED_METADATA, MAP_ROUTE_TOP_LEVEL_FIELDS, readStoredRouteMetadata,
} from '../src/lib/mapRouteFields.js';

// The owner's 43 saved routes were 5.2 MB on the map, 3.8 MB of it saved road
// paths the map never draws. The map now loads routes without them.

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the map route list leaves out only the saved road path', () => {
    for (const key of MAP_ROUTE_OMITTED_METADATA) {
        assert.ok(!MAP_ROUTE_METADATA_KEYS.includes(key));
        assert.ok(!MAP_ROUTE_FIELDS.some(field => field === 'metadata' || field === `metadata.${key}`));
    }
    // Every SavedRoute field the schema defines, other than metadata itself.
    const schema = JSON.parse(read('base44/entities/SavedRoute.jsonc'));
    for (const field of Object.keys(schema.properties).filter(field => field !== 'metadata')) {
        assert.ok(MAP_ROUTE_TOP_LEVEL_FIELDS.includes(field), field);
    }
    for (const field of ['id', 'created_date', 'updated_date', 'created_by', 'property_hashes', 'status', 'assigned_to', 'metrics']) {
        assert.ok(MAP_ROUTE_TOP_LEVEL_FIELDS.includes(field), field);
    }
    // Metadata the map, route list, badges and actions read.
    for (const key of ['route_bounds', 'precision_area', 'newly_generated', 'generated_at', 'last_optimization_attempt',
        'road_access_recovery', 'routing', 'road_search_coverage', 'road_verification', 'road_geometry_provenance',
        'split_source', 'split_replacement', 'rerun_from_route_id', 'rerun_filter', 'anchor', 'imports',
        'road_aware_comparison_id', 'property_order_fingerprint']) {
        assert.ok(MAP_ROUTE_METADATA_KEYS.includes(key), key);
    }
    assert.equal(new Set(MAP_ROUTE_FIELDS).size, MAP_ROUTE_FIELDS.length);
    // Base44 receives the list in the request; it was accepted live at this size.
    assert.ok(MAP_ROUTE_FIELDS.join(',').length < 5500);
});

test('Home reads its saved routes with the map route fields', () => {
    const home = read('src/pages/Home.jsx');
    assert.match(home, /import \{ MAP_ROUTE_FIELDS \} from '@\/lib\/mapRouteFields';/);
    assert.match(home, /base44\.entities\.SavedRoute\.filter\(filter, '-created_date', limit, skip, fields \|\| MAP_ROUTE_FIELDS\)/);
});

test('a save reads the stored metadata, and refuses when the route cannot be read', async () => {
    const stored = { road_geometry_segments: [{ points: [] }], route_bounds: { enabled: false }, added_later: true };
    const client = { entities: { SavedRoute: { get: async id => (id === 'r1' ? { id: 'r1', metadata: stored } : null) } } };
    assert.deepEqual(await readStoredRouteMetadata(client, { id: 'r1', metadata: { route_bounds: { enabled: false } } }), stored);
    await assert.rejects(readStoredRouteMetadata(client, { id: 'gone', metadata: {} }), /could not be re-read/);
    const failing = { entities: { SavedRoute: { get: async () => { throw new Error('network'); } } } };
    await assert.rejects(readStoredRouteMetadata(failing, { id: 'r1', metadata: {} }), /left unchanged/);
    // Unsaved and offline-only routes have nothing stored yet.
    assert.deepEqual(await readStoredRouteMetadata(failing, { id: 'route-1', isSaved: false, metadata: { a: 1 } }), { a: 1 });
    assert.deepEqual(await readStoredRouteMetadata(failing, { id: 'local_1', metadata: { b: 2 } }), { b: 2 });
});

function optimizeHarness({ storedMetadata, getFails = false, result }) {
    const executable = path => ts.transpileModule(read(path), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export\s*\{[^}]*\}\s*from[^;]*;\s*$/gm, '').replace(/^export\s+/gm, '');
    const writes = [];
    const errors = [];
    const properties = [
        { address_hash: 'a', lat: 33.451, lng: -112.074 },
        { address_hash: 'b', lat: 33.471, lng: -112.064 },
        { address_hash: 'c', lat: 33.461, lng: -112.074 },
    ];
    const client = {
        functions: { invoke: async () => ({ data: {} }) },
        entities: { SavedRoute: {
            get: async id => { if (getFails) throw new Error('offline'); return { id, metadata: structuredClone(storedMetadata) }; },
            update: async (id, update) => { writes.push(update); return { id, ...update }; },
        } },
    };
    const context = vm.createContext({
        ...routeDisplayGeometry,
        hasCompleteRouteMapPoints, loadSavedRouteSelection, readStoredRouteMetadata,
        hydrateRouteForMap: () => assert.fail('fixture homes are already loaded'),
        OPTIMIZE_MODES, ROUTE_ORIGIN_MODES, resolveOptimizeMode, routeOriginModeForOptimizeMode,
        isValidRoutePoint, console, base44: client,
        toast: { loading() {}, success() {}, info() {}, warning() {}, error: message => errors.push(message) },
        startOptimizeProgress: () => ({ update() {}, stop() {} }),
        LONG_OPTIMIZATION_STOPS: 150, startRoadOptimizationJob: () => ({ startRoute() {}, progress() {}, finish() {} }),
        ROAD_VERIFICATION: { ADOPTED: 'adopted' }, stampRoadVerification: () => ({ metadata: {} }),
        claimRouteOptimization: () => 1, routeGuardSnapshot: () => ({}), finishInBackground: async () => ({ saved: false }),
        optimizeFirstThenFinish: (order) => {
            const value = typeof result === 'function' ? result(order) : result;
            const first = Promise.resolve({ more: false, ...value });
            return { first, final: first };
        },
        countChangedRouteStops: (before, after) => after.filter((hash, i) => hash !== before[i]).length,
        persistOptimizedRoute: async ({ route, update, client: target }) => target.entities.SavedRoute.update(route.id, update),
        syncOptimizedRoute: async () => {},
    });
    vm.runInContext(executable('src/lib/routeOptimizationOutcome.js'), context);
    vm.runInContext(executable('src/lib/routeOptimizeUpdate.js'), context);
    vm.runInContext(executable('src/lib/reoptimizeRouteAction.js'), context);
    // The map's copy: no road path, and no key added after the field list.
    const leanRoute = { id: 'route', property_hashes: ['a', 'b', 'c'], properties,
        metadata: { route_bounds: { enabled: false }, precision_area: { job_id: 'job' } } };
    return { writes, errors, optimize: () => context.reoptimizeRoute(leanRoute, { mode: 'route_only' }, { user: { id: 'manager' } }) };
}

const STORED = {
    route_bounds: { enabled: false }, precision_area: { job_id: 'job' }, added_later: { keep: true },
    road_geometry_segments: [{ points: [{ lat: 33.451, lng: -112.074 }, { lat: 33.471, lng: -112.064 }] }],
    road_geometry_provenance: { order: ['a', 'b', 'c'] },
};

test('Optimize with nothing shorter saves onto the stored record, not the map\'s lean copy', async () => {
    const harness = optimizeHarness({ storedMetadata: STORED,
        result: { result: null, reason: 'current_order_measured_best', measurement: { routingMetadata: {} } } });
    await harness.optimize();
    assert.equal(harness.writes.length, 1);
    const metadata = harness.writes[0].metadata;
    assert.deepEqual(metadata.added_later, { keep: true }, 'a key outside the field list survives');
    assert.deepEqual(metadata.road_geometry_segments, STORED.road_geometry_segments, 'the unchanged order keeps its road path');
    assert.equal(metadata.precision_area.job_id, 'job');
    assert.ok(metadata.last_optimization_attempt);
});

test('Optimize that reorders starts from the stored record too', async () => {
    const harness = optimizeHarness({ storedMetadata: STORED, result: order => ({
        result: { order: [...order].reverse(), objective: { applyCandidate: true, appliedDistance: 3, estimatedSavings: 1 }, routingMetadata: {} },
    }) });
    await harness.optimize();
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.writes.length, 1);
    assert.deepEqual(harness.writes[0].property_hashes, ['c', 'b', 'a']);
    assert.deepEqual(harness.writes[0].metadata.added_later, { keep: true });
    // A new order clears the old road path, as before.
    assert.equal(harness.writes[0].metadata.road_geometry_segments, undefined);
});

test('Optimize saves nothing when the stored route cannot be read', async () => {
    const harness = optimizeHarness({ storedMetadata: STORED, getFails: true,
        result: { result: null, reason: 'current_order_measured_best', measurement: { routingMetadata: {} } } });
    await harness.optimize();
    assert.equal(harness.writes.length, 0);
    assert.match(harness.errors.join(' '), /could not be re-read, so it was left unchanged/);
});
