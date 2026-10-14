import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import { retryRead, shouldRetryRead, withReadDeadline } from '../src/lib/readRequest.js';
import * as loading from '../src/components/map/mapTerritoryLoading.js';

const user = { email: 'manager@example.com', territory_zip_codes: ['85001'], generated_zip_codes: ['85002'] };
const property = { id: '1', address_hash: 'door-1', lat: 33.4, lng: -112.1 };
const source = readFileSync(new URL('../src/components/map/useViewportMapProperties.jsx', import.meta.url), 'utf8');
const executable = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\s*$/gm, '').replace('export default function', 'function');

// Run the production hook with persistent hook slots so staged responses,
// retry actions and account changes can be exercised without a DOM/Leaflet.
function hookHarness(invoke = async () => ({ data: { properties: [] } })) {
    const slots = [];
    let position = 0, effects = [], responses = {}, descriptors = {};
    const sandbox = {
        ...loading, withReadDeadline, base44: { functions: { invoke } },
        console: { log() {}, warn() {} },
        useRef(value) {
            const slot = position++;
            return slots[slot] ||= { current: value };
        },
        useState(value) {
            const slot = position++;
            if (!(slot in slots)) slots[slot] = value;
            return [slots[slot], next => { slots[slot] = next; }];
        },
        useEffect(effect, dependencies) {
            const slot = position++;
            const previous = slots[slot];
            if (!previous || dependencies.some((dependency, index) => dependency !== previous[index])) effects.push(effect);
            slots[slot] = dependencies;
        },
        useCallback(callback, dependencies) {
            const slot = position++;
            const previous = slots[slot];
            if (!previous || dependencies.some((dependency, index) => dependency !== previous.dependencies[index])) {
                slots[slot] = { callback, dependencies };
            }
            return slots[slot].callback;
        },
        useQuery(config) {
            const stage = config.queryKey.at(-1);
            descriptors[stage] = config;
            return { data: undefined, error: null, isLoading: !!config.enabled, isSuccess: false,
                refetch: async () => ({ data: responses[stage]?.data }), ...responses[stage] };
        },
    };
    vm.runInNewContext(`${executable}\nglobalThis.hook = useViewportMapProperties;`, sandbox);
    return {
        render(data = {}, currentUser = user) {
            position = 0; effects = []; descriptors = {}; responses = data;
            const result = sandbox.hook(currentUser);
            effects.forEach(effect => effect());
            return { result, descriptors };
        },
    };
}

test('bootstrap is 1K slim homes and retains account-scoped legacy invalidations', async () => {
    const requests = [];
    const harness = hookHarness(async (name, body) => {
        requests.push({ name, body });
        return { data: { properties: [property], capped: false } };
    });
    const { result, descriptors } = harness.render();
    assert.equal(result.isLoading, true);
    assert.equal(descriptors.overview.enabled, false);
    await descriptors.bootstrap.queryFn();
    assert.equal(requests[0].body.limit, 1000);
    assert.equal(requests[0].body.fields, 'map');
    assert.deepEqual(requests[0].body.zip_codes, ['85001', '85002']);
    assert.equal(descriptors.bootstrap.queryKey[0], 'masterProperties');
});

test('small territories finish with one request; capped bootstrap restores the complete 20K overview', async () => {
    const harness = hookHarness();
    const bootstrap = { isSuccess: true, isLoading: false, data: { properties: [property], capped: false } };
    let rendered = harness.render({ bootstrap });
    assert.equal(rendered.result.isOverviewReady, true);
    assert.equal(rendered.descriptors.overview.enabled, false);
    bootstrap.data = { properties: [property], capped: true };
    rendered = harness.render({ bootstrap });
    assert.equal(rendered.descriptors.overview.enabled, true);
    assert.equal(rendered.result.isOverviewReady, false);
    assert.equal(rendered.result.baseProperties.length, 1);
    const complete = [property, { ...property, id: '2', address_hash: 'door-2' }];
    rendered = harness.render({ bootstrap, overview: {
        isSuccess: true, isLoading: false, data: { properties: complete, capped: false },
    } });
    assert.equal(rendered.result.isOverviewReady, true);
    assert.equal(rendered.result.baseProperties, complete);
});

test('an overview failure keeps bootstrap homes usable and exposes retry without declaring completion', async () => {
    const error = new Error('Temporarily unavailable');
    let retries = 0;
    const bootstrap = { isSuccess: true, isLoading: false, data: { properties: [property], capped: true } };
    const { result } = hookHarness().render({ bootstrap, overview: {
        isLoading: false, error, refetch: async () => { retries++; },
    } });
    assert.equal(result.baseProperties[0], property);
    assert.equal(result.isOverviewReady, false);
    assert.equal(result.error, error);
    await result.retry();
    assert.equal(retries, 1);
});

test('malformed territory responses retry rather than becoming a successful empty map', async () => {
    let calls = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryRead, retryDelay: 0 } } });
    try {
        const result = await client.fetchQuery({ queryKey: ['map-load-test'], queryFn: () => loading.fetchMapTerritory(async () => {
            return ++calls === 1 ? { data: { error: 'Busy' } } : { data: { properties: [property], capped: false } };
        }, user, loading.MAP_BOOTSTRAP_LIMIT) });
        assert.equal(result.properties[0], property);
        assert.equal(calls, 2);
    } finally { client.clear(); }
});

test('a viewport response from a previous account cannot populate the current account', async () => {
    let finish;
    const harness = hookHarness(() => new Promise(resolve => { finish = resolve; }));
    const ready = { bootstrap: { isSuccess: true, isLoading: false, data: { properties: [property], capped: true } },
        overview: { isSuccess: true, isLoading: false, data: { properties: [property], capped: true } } };
    const { result } = harness.render(ready);
    const pending = result.onMapMoveEnd({ getNorth: () => 33.5, getSouth: () => 33.4, getEast: () => -112, getWest: () => -112.1 });
    await Promise.resolve();
    harness.render({}, { ...user, email: 'other@example.com' });
    finish({ data: { properties: [property] } });
    await pending;
    assert.equal(harness.render({}, { ...user, email: 'other@example.com' }).result.viewportProperties.length, 0);
});

test('a failed viewport fetch exposes recovery and the same bounds can load on retry', async () => {
    let calls = 0;
    const error = new Error('Connection dropped');
    const extraDoor = { ...property, id: '2', address_hash: 'door-2' };
    const harness = hookHarness(async () => {
        if (++calls === 1) throw error;
        return { data: { properties: [extraDoor] } };
    });
    const ready = { bootstrap: { isSuccess: true, isLoading: false, data: { properties: [property], capped: true } },
        overview: { isSuccess: true, isLoading: false, data: { properties: [property], capped: true } } };
    const { result } = harness.render(ready);
    await result.onMapMoveEnd({ getNorth: () => 33.5, getSouth: () => 33.4, getEast: () => -112, getWest: () => -112.1 });
    const failed = harness.render(ready).result;
    assert.equal(failed.error, error);
    await failed.retry();
    const recovered = harness.render(ready).result;
    assert.equal(calls, 2);
    assert.equal(recovered.error, null);
    assert.equal(recovered.viewportProperties[0].address_hash, 'door-2');
});

const homeSource = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
const homeAst = ts.createSourceFile('Home.jsx', homeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const home = homeAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Home');
function callback(name, bindings) {
    let expression;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(homeAst) === name) expression = node.initializer.arguments[0].getText(homeAst);
        ts.forEachChild(node, visit);
    }
    visit(home);
    return vm.runInNewContext(`(${expression})`, { toast: { info() {} }, ...bindings });
}

test('route candidate recovery retries the same completed import and preserves its polygon', async () => {
    const calls = [];
    const polygon = [{ lat: 33, lng: -112 }, { lat: 34, lng: -112 }, { lat: 33, lng: -113 }];
    const load = callback('fetchRouteCandidatesFromNeon', {
        normalizeOwnershipRangeDays: () => null,
        retryRead: read => retryRead(read, { delay: () => 0, wait: async () => {} }),
        base44: { functions: { invoke: async (name, body) => {
            calls.push({ name, body });
            if (calls.length === 1) throw Object.assign(new Error('Server busy'), { response: { status: 500 } });
            return { data: { properties: [property], capped: false } };
        } } }
    });
    const properties = await load({ polygon, fetchJobId: 'completed-import', soldMonths: 12 });
    assert.equal(properties[0], property);
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.name, 'getRouteCandidatesFromNeon');
        assert.equal(call.body.fetch_job_id, 'completed-import');
        assert.equal(call.body.polygon, polygon);
        assert.equal(call.body.sold_months, 12);
    }
});

test('a candidate response that hits the safety cap still blocks generation after request recovery', async () => {
    let calls = 0;
    const load = callback('fetchRouteCandidatesFromNeon', {
        normalizeOwnershipRangeDays: () => null,
        retryRead: read => retryRead(read, { delay: () => 0, wait: async () => {} }),
        base44: { functions: { invoke: async () => {
            if (++calls === 1) throw Object.assign(new Error('Server busy'), { status: 503 });
            return { data: { properties: [property], capped: true, limit: 50000 } };
        } } }
    });
    await assert.rejects(load({ fetchJobId: 'completed-import' }), /safety window/);
    assert.equal(calls, 2);
});

test('Home always mounts the map while territory loads and keeps history-dependent layers gated', () => {
    const topLevelReturns = home.body.statements.filter(ts.isReturnStatement);
    assert.equal(topLevelReturns.length, 1);
    assert.match(topLevelReturns[0].getText(homeAst), /<MapContainer/);
    assert.match(homeSource, /\{logsReady && <ManagerMapLayers/);
    assert.match(homeSource, /showChecklist && filteredActiveRoute && checklistLogsReady && logsReady/);
    assert.match(homeSource, /selectedProperty && selectedPropertyHistoryReady \? withDerivedStatus/);
});

test('generation and reorder do not use the incomplete bootstrap inventory', async () => {
    assert.equal(await callback('generateRoutes', { territoryActionsReady: false })(), false);
    assert.equal(await callback('handleReorder', { territoryActionsReady: false })(), false);
    assert.equal(await callback('handleReoptimizeRoute', { territoryActionsReady: false })({}, {}), null);
});

test('manager outcomes wait for account, checklist and selected-property history', async () => {
    for (const bindings of [
        { logsReady: false },
        { logsReady: true, showChecklist: true, checklistLogsReady: false },
        { logsReady: true, showChecklist: false, selectedProperty: property, selectedPropertyHistoryReady: false },
    ]) {
        const result = await callback('handleLogResult', bindings)(property, 'SOLD');
        assert.equal(result, false);
    }
});
