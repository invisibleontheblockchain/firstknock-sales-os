import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { getCompletedPrecisionRoutes, loadPrecisionGenerationJob } from '../src/lib/precisionDelivery.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function declaration(path, name) {
    const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let found;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(found, `${name} must exist in production`);
    return found;
}
const pollSource = declaration('src/components/map/TerritoryPrompt.jsx', 'startPolling');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function pollHarness({ status = async () => ({ status: 'completed', active_count: 43 }), complete = async () => true,
    refetch = async () => {} } = {}) {
    const intervals = new Map();
    const state = { requests: [], builds: [], cleared: [], modes: [], delays: [], now: Date.now() };
    let nextTimer = 0;
    const sandbox = {
        Date: class extends Date { static now() { return state.now; } },
        console: { warn() {} },
        pollRef: { current: null }, pollSessionRef: { current: null }, activeJobIdRef: { current: null },
        routeModeRef: { current: 'precision' }, pctHistoryRef: { current: [] }, targetPctRef: { current: 0 },
        pullIntentRef: { current: {} }, isDeltaPull: false, isPaid: true, fetchMonths: 12,
        setInterval: (callback, delay) => { const id = ++nextTimer; state.delays.push(delay); intervals.set(id, callback); return id; },
        clearInterval: id => intervals.delete(id),
        base44: {
            functions: { invoke: async (_, { job_id }) => { state.requests.push(job_id); return { data: await status(job_id) }; } },
            auth: { updateMe: async () => {} },
        },
        normalizeOwnershipRangeDays: range => range,
        ownershipRangeCriteria: range => range,
        buildPrecisionShortfallMessage: () => '',
        toast: { info() {}, success() {}, error() {} },
        window: { dispatchEvent() {} }, CustomEvent: class {},
        onPullComplete: async (...args) => { state.builds.push(args[2].job_id); return complete(...args); },
        clearActivePrecisionJob: id => state.cleared.push(id), refetchPrecisionUsage: refetch,
        onRouteBoundsPrepared: async () => {},
        queryClient: { invalidateQueries() {} },
    };
    for (const name of ['Pulling', 'PullPct', 'DisplayPct', 'EtaText', 'PullProgress', 'TotalExpected',
        'IsDeltaPull', 'ShowRoutePanel', 'ShowCompare']) {
        sandbox[`set${name}`] = value => { state[name] = value; };
    }
    sandbox.setMode = value => state.modes.push(value);
    return { sandbox, state, intervals, start: vm.runInNewContext(`(${pollSource})`, sandbox) };
}

test('slow completion polls and repeated resume signals build a job exactly once through saving', async () => {
    const response = deferred();
    const saving = deferred();
    const poll = pollHarness({ status: () => response.promise, complete: () => saving.promise });
    poll.start('job-43');
    const tick = [...poll.intervals.values()][0];
    await tick();
    await tick();
    poll.start('job-43');
    assert.equal(poll.state.requests.length, 1, 'A slow request cannot overlap the next interval');
    response.resolve({ status: 'completed', active_count: 43 });
    await flush();
    assert.deepEqual(poll.state.builds, ['job-43']);
    assert.equal(poll.intervals.size, 0);
    poll.start('job-43');
    await tick(); // Even an already queued interval cannot start a second build.
    assert.equal(poll.state.requests.length, 1);
    saving.resolve(true);
    await flush();
    poll.start('job-43');
    await tick();
    assert.deepEqual(poll.state.builds, ['job-43']);
    assert.deepEqual(poll.state.cleared, ['job-43']);
    assert.equal(poll.state.Pulling, false);
});

test('a superseded poll cannot restore an older job over a newer route build', async () => {
    const old = deferred();
    const poll = pollHarness({ status: id => id === 'old' ? old.promise : { status: 'completed', active_count: 43 } });
    poll.start('old');
    poll.start('new');
    await flush();
    old.resolve({ status: 'completed', active_count: 10 });
    await flush();
    assert.deepEqual(poll.state.builds, ['new']);
    assert.deepEqual(poll.state.cleared, ['new']);
});

test('network errors keep polling, but failed builds retain recovery without an automatic second attempt', async () => {
    let calls = 0;
    const poll = pollHarness({ status: async () => {
        if (++calls === 1) throw new Error('Temporary outage');
        return { status: 'completed', active_count: 43 };
    }, complete: async () => false });
    poll.start('retryable');
    await flush();
    assert.equal(poll.intervals.size, 1);
    await [...poll.intervals.values()][0]();
    assert.deepEqual(poll.state.builds, ['retryable']);
    assert.deepEqual(poll.state.cleared, []);
    assert.equal(poll.state.Pulling, false);
    poll.start('retryable');
    await flush();
    assert.equal(poll.state.builds.length, 1);
});

test('usage refresh failure cannot leave a successful build marked as pending recovery', async () => {
    const poll = pollHarness({ refetch: async () => { throw new Error('Usage temporarily unavailable'); } });
    poll.start('saved');
    await flush();
    assert.deepEqual(poll.state.cleared, ['saved']);
    assert.equal(poll.state.Pulling, false);
});

test('a failed or cancelled import can be explicitly restarted with the same job id', async () => {
    for (const terminal of ['failed', 'cancelled']) {
        let attempts = 0;
        const poll = pollHarness({ status: async () => ({ status: ++attempts === 1 ? terminal : 'completed', active_count: 43 }) });
        poll.start('restarted');
        await flush();
        assert.equal(poll.intervals.size, 0);
        poll.start('restarted');
        await flush();
        assert.deepEqual(poll.state.builds, ['restarted']);
    }
});

const job = { id: 'job-43', dry_run_metadata: {} };
const candidates = Array.from({ length: 43 }, (_, i) => ({ address_hash: `home-${i}` }));
const savedRoute = { id: 'saved-43', status: 'ACTIVE', property_hashes: candidates.map(p => p.address_hash),
    metadata: { precision_area: { job_id: job.id } } };

test('refresh after saving recovers all 43 homes before the assigned-home exclusion can reject them', async () => {
    assert.deepEqual(getCompletedPrecisionRoutes(job, [savedRoute], candidates), [savedRoute]);
    const reported = { status: 'completed', generated_homes_reported: 43, saved_route_homes_verified: 43 };
    const loaded = await loadPrecisionGenerationJob({ functions: { invoke: async () => ({ data: {
        job_id: job.id, status: 'completed', provider: 'batchdata', mode_tag: 'PRECISION_TARGET',
        diagnostics: { final_delivery: reported },
    } }) } }, job.id);
    assert.deepEqual(getCompletedPrecisionRoutes(loaded, [savedRoute]), [savedRoute], 'Verified delivery can reopen without another candidate fetch');
});

test('partial saves, other jobs, archived routes, and offline routes cannot masquerade as completed delivery', () => {
    for (const route of [
        { ...savedRoute, property_hashes: savedRoute.property_hashes.slice(0, 20) },
        { ...savedRoute, metadata: { precision_area: { job_id: 'another-job' } } },
        { ...savedRoute, status: 'ARCHIVED' }, { ...savedRoute, id: 'local_saved-43' },
    ]) assert.deepEqual(getCompletedPrecisionRoutes(job, [route], candidates), []);
    const confirmed = { ...job, dry_run_metadata: { final_delivery: {
        status: 'completed', generated_homes_reported: 43, saved_route_homes_verified: 43,
    } } };
    assert.deepEqual(getCompletedPrecisionRoutes(confirmed, [{ ...savedRoute, property_hashes: ['home-0'] }]), [],
        'A missing route chunk still needs recovery even with an older successful report');
});

test('reopening a saved generation hydrates pins and exits Builder without saving or reporting a failed attempt', async () => {
    const state = {};
    const sandbox = {
        getCompletedPrecisionRoutes, precisionJob: job, savedPrecisionRoutes: [savedRoute],
        routeHomeRowsRef: { current: [] }, user: { email: 'manager@example.com' },
        deliveryAttempt: { status: 'failed' },
        loadSavedRouteSelection: async (route, _, hydrate) => hydrate(route),
        hydrateRouteForMap: async route => ({ ...route, properties: candidates }),
        setActiveRoute: value => { state.route = value; }, setRoutes: value => { state.routes = value; },
        setGenerationError: value => { state.error = value; }, finishRouteBuild: () => { state.mode = 'analyze'; },
        toast: { success() {} },
    };
    const restore = vm.runInNewContext(`(${declaration('src/pages/Home.jsx', 'restoreCompletedRoute')})`, sandbox);
    assert.equal(await restore(candidates), true);
    assert.equal(state.route.id, savedRoute.id);
    assert.equal(state.route.properties.length, 43);
    assert.equal(state.mode, 'analyze');
    assert.equal(state.error, null);
    assert.equal(sandbox.deliveryAttempt, null);
});

test('entering Builder clears route selection, preview, and route-only panels; Routes stops drawing', () => {
    const state = { ActiveRoute: savedRoute, PreviewRoute: savedRoute, ShowChecklist: true, SelectedProperty: candidates[0], DrawingMode: true };
    const sandbox = { useCallback: callback => callback };
    for (const name of ['ActiveRoute', 'PreviewRoute', 'ShowChecklist', 'SelectedProperty', 'DrawingMode', 'ModeRaw']) {
        sandbox[`set${name}`] = value => { state[name] = value; };
    }
    const changeMode = vm.runInNewContext(declaration('src/pages/Home.jsx', 'setMode'), sandbox);
    changeMode('generate');
    assert.equal(state.ActiveRoute, null);
    assert.equal(state.PreviewRoute, null);
    assert.equal(state.ShowChecklist, false);
    assert.equal(state.SelectedProperty, null);
    assert.equal(state.ModeRaw, 'generate');
    changeMode('analyze');
    assert.equal(state.DrawingMode, false);
});

test('Builder never mounts route lines or pins even if a background callback supplies an active route', () => {
    const path = 'src/components/map/ManagerMapLayers.jsx';
    const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const conditions = [];
    const visit = node => {
        if (ts.isJsxExpression(node) && node.expression && /<ActiveRouteLayer\b|<Polyline\b/.test(node.expression.getText(ast))) {
            if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                const condition = node.expression.left.getText(ast);
                if (condition.includes('activeRoute') || condition.includes('previewRoute')) conditions.push(condition);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.equal(conditions.length, 2);
    for (const condition of conditions) {
        const sandbox = { mode: 'generate', activeRoute: savedRoute, previewRoute: savedRoute };
        assert.equal(vm.runInNewContext(condition, sandbox), false);
        sandbox.mode = 'analyze';
        sandbox.previewRoute = null;
        const activeLayer = condition.includes('previewRoute') ? null : vm.runInNewContext(condition, sandbox);
        if (activeLayer) assert.equal(activeLayer.id, savedRoute.id);
    }
});

test('Max Available shows checked records without presenting the credit allowance as a provider total', async () => {
    const status = { status: 'running', phase: 'batchdata_scanning', progress_pct: 80,
        total_fetched: 184, total_expected: 997134, diagnostics: { count_mode: 'max_available' } };
    const poll = pollHarness({ status: async () => status });
    poll.start('max-available');
    await flush();
    assert.equal(poll.state.PullProgress, '184 records checked • 0 ready for routes');
    assert.deepEqual(poll.state.delays, [5000]);
    poll.state.now += 5 * 60 * 1000;
    await [...poll.intervals.values()][0]();
    assert.match(poll.state.EtaText, /Taking longer than usual/);
    assert.doesNotMatch(poll.state.EtaText, /under 2 minutes|Almost done/);
    status.diagnostics.count_mode = 'fixed';
    status.total_expected = 200;
    await [...poll.intervals.values()][0]();
    assert.equal(poll.state.PullProgress, '184 of 200 records checked • 0 ready for routes');
});

test('throttled polls back off without overlapping or forgetting the job, then return to normal cadence', async () => {
    let calls = 0;
    const poll = pollHarness({ status: async () => {
        if (++calls === 1) throw Object.assign(new Error('App entity read traffic volume limit exceeded'), { status: 429 });
        return { status: 'running', progress_pct: 80, total_fetched: 184 };
    } });
    poll.start('busy-import');
    await flush();
    assert.deepEqual(poll.state.delays, [5000, 30000]);
    assert.match(poll.state.EtaText, /Service is busy/);
    assert.equal(poll.sandbox.activeJobIdRef.current, 'busy-import');
    assert.equal(poll.intervals.size, 1);
    assert.deepEqual(poll.state.cleared, []);
    await [...poll.intervals.values()][0]();
    assert.deepEqual(poll.state.delays, [5000, 30000, 5000]);
    assert.equal(poll.intervals.size, 1);
    assert.equal(poll.state.requests.length, 2);
});

test('a late failure from an older poll cannot change a newer job status or timers', async () => {
    const old = deferred();
    const poll = pollHarness({ status: id => id === 'old' ? old.promise.then(() => { throw new Error('Old network error'); })
        : { status: 'running', progress_pct: 80, total_fetched: 184 } });
    poll.start('old');
    poll.start('new');
    await flush();
    const currentText = poll.state.EtaText;
    old.resolve();
    await flush();
    assert.equal(poll.state.EtaText, currentText);
    assert.deepEqual(poll.state.delays, [5000, 5000]);
    assert.equal(poll.intervals.size, 1);
});

test('a backend 500 carrying a read-traffic error uses the throttling backoff', async () => {
    const poll = pollHarness({ status: async () => {
        throw Object.assign(new Error('Request failed with status code 500'), {
            response: { status: 500, data: { error: 'App entity read traffic volume limit exceeded' } }
        });
    } });
    poll.start('busy-backend');
    await flush();
    assert.deepEqual(poll.state.delays, [5000, 30000]);
    assert.match(poll.state.EtaText, /Service is busy/);
    assert.equal(poll.sandbox.activeJobIdRef.current, 'busy-backend');
});

test('Max Available does not claim an allowance shortfall but still warns when provider pages were lost', () => {
    const ast = ts.createSourceFile('TerritoryPrompt.jsx', read('src/components/map/TerritoryPrompt.jsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildPrecisionShortfallMessage');
    const message = vm.runInNewContext(`(${declaration.getText(ast)})`);
    const order = { loadedCount: 184, requestedCount: 997134, diagnostics: { count_mode: 'max_available' } };
    assert.equal(message(order), null);
    assert.match(message({ ...order, diagnostics: { ...order.diagnostics, partial_delivery: true } }), /could not be retrieved/);
});
