import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoadSearchCoverage, roadSearchWindowKey, MAX_ROAD_SEARCH_COVERAGE_KEYS } from '../base44/shared/roadSearchCoverage.js';
import { LOCAL_DRIVING_REVIEW_VERSION, reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';
import { reviewFinalNeighborhoodRoute } from '../base44/shared/finalNeighborhoodReview.js';
import { planShortDrivingWindows } from '../base44/shared/shortDrivingWindows.js';

const policy = LOCAL_DRIVING_REVIEW_VERSION;
const ids = order => order.map(p => p.id);
const stops = (size = 24) => Array.from({ length: size }, (_, i) => ({ id: `door-${i}`, rank: i,
    house_number: String(100 + i), street_name: 'Coverage Lane', city: 'Test City', state: 'NC', zip_code: '28000',
    lat: 35, lng: -81 + i / 100000 }));
const windows = [{ start: 2, end: 5, local: true }, { start: 9, end: 12, local: true }, { start: 16, end: 19, local: true }];
const makeMeasurement = (order, cost) => {
    const directedLegs = order.slice(1).map((p, i) => ({ from: order[i].id, to: p.id,
        pathKey: `${order[i].id}>${p.id}`, driveSeconds: cost(order[i], p), distanceMiles: cost(order[i], p) / 1609.344 }));
    return { directedLegs, driveSeconds: directedLegs.reduce((sum, leg) => sum + leg.driveSeconds, 0),
        distanceMiles: directedLegs.reduce((sum, leg) => sum + leg.distanceMiles, 0), dataVersion: 'fixed-road-graph',
        estimatedTurnarounds: 0, geometry: order.map(p => ({ lat: p.lat, lng: p.lng })) };
};
function fixture({ improve = false, failCandidate = false, delayBaseline = false } = {}) {
    const order = stops();
    // Identical geometric priorities make the later road question sit below
    // the finite two-window cutoff. Roads, rather than geometry, reveal it.
    order.forEach(p => { p.lng = -81; });
    if (improve) [order[17], order[18]] = [order[18], order[17]];
    const calls = [];
    const cost = (a, b) => improve ? b.rank === a.rank + 1 ? 1 : 20 + Math.abs(b.rank - a.rank) : 1;
    const options = { reviewWindows: windows, areaDrivingReview: false, maxLocalWindows: 2, localReviewBudgetMs: 5000,
        createLocalDrivingContext: async (section, config) => {
            calls.push({ ids: ids(section), config });
            return { accessFor: p => p.routing_access, optimizationCostBetween: cost,
                distanceBetween: (a, b) => cost(a, b) / 1609.344,
                async routeSequence(sequence) {
                    const baseline = ids(sequence).join() === ids(section).join();
                    if (failCandidate && !baseline) throw new Error('Road provider unavailable.');
                    if (delayBaseline && baseline) await new Promise(resolve => setTimeout(resolve, 30));
                    return makeMeasurement(sequence, cost);
                } };
        } };
    return { order, options, calls };
}

test('an unchanged bounded pass continues with unseen questions instead of repeating the same prefix', async () => {
    const f = fixture();
    const first = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalWindows: 1 });
    assert.equal(first.properties, f.order);
    assert.equal(first.searchCoverage.checked_this_pass, 1);
    assert.equal(first.searchCoverage.progress_this_pass, 1);
    assert.equal(first.searchCoverage.remaining_windows, 2);
    assert.equal(first.searchCoverage.cycle_complete, false);
    const firstQuestion = f.calls[0].ids.join();
    f.calls.length = 0;
    const second = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalWindows: 1,
        searchCoverage: first.searchCoverage });
    assert.notEqual(f.calls[0].ids.join(), firstQuestion);
    assert.equal(second.searchCoverage.completed_window_keys.length, 2);
    assert.equal(second.searchCoverage.progress_this_pass, 1);
    assert.equal(second.searchCoverage.remaining_windows, 1);
    f.calls.length = 0;
    const third = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalWindows: 1,
        searchCoverage: second.searchCoverage });
    assert.equal(third.searchCoverage.cycle_complete, true);
    assert.equal(third.searchCoverage.remaining_windows, 0);
    const thirdQuestion = f.calls[0].ids.join();
    f.calls.length = 0;
    const repeated = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalWindows: 1,
        searchCoverage: third.searchCoverage });
    assert.notEqual(f.calls[0].ids.join(), thirdQuestion, 'a completed cycle starts a new bounded review');
    assert.equal(repeated.searchCoverage.progress_this_pass, 1);
});

test('continuation reaches a later real road improvement and still measures its complete directed trip', async () => {
    const f = fixture({ improve: true });
    const first = await reviewLocalDrivingNeighborhoods(f.order, f.options);
    assert.equal(first.diagnostics.applied, false);
    assert.equal(first.searchCoverage.completed_window_keys.length, 2);
    const firstContexts = f.calls.map(call => call.ids.join());
    f.calls.length = 0;
    const second = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, searchCoverage: first.searchCoverage });
    assert.ok(!firstContexts.includes(f.calls[0].ids.join()), 'the hidden third window must receive the next road budget');
    assert.deepEqual(second.properties.map(p => p.rank), Array.from({ length: 24 }, (_, i) => i));
    assert.equal(second.diagnostics.validation, 'whole_route');
    assert.ok(second.measurement.driveSeconds < second.baseline.driveSeconds);
    assert.equal(second.measurement.directedLegs.length, f.order.length - 1);
    assert.deepEqual(new Set(second.properties), new Set(f.order));
    assert.ok(f.calls.some(call => call.ids.length === f.order.length), 'the accepted trip must be checked as a whole');
    assert.equal(second.searchCoverage.remaining_windows, 1,
        'the repaired ordered question is new; its old key cannot claim the new order was exhaustively searched');
});

test('changed local context prunes only affected questions while unrelated completed sections remain scheduled as seen', async () => {
    const f = fixture();
    const first = await reviewLocalDrivingNeighborhoods(f.order, f.options);
    const changed = structuredClone(f.order);
    changed[2].lat += 0.0001;
    const second = await reviewLocalDrivingNeighborhoods(changed, { ...f.options, maxLocalWindows: 0,
        searchCoverage: first.searchCoverage });
    assert.equal(second.searchCoverage.completed_window_keys.length, 1);
    assert.equal(second.searchCoverage.remaining_windows, 2);
    assert.equal(second.searchCoverage.progress_this_pass, 0);
    assert.ok(first.searchCoverage.completed_window_keys.includes(second.searchCoverage.completed_window_keys[0]));
});

for (const [name, mutate] of [
    ['ordered doors', (order) => { [order[3], order[4]] = [order[4], order[3]]; }],
    ['outer arrival context', (order) => { order[0].lat += 0.001; }],
    ['street identity', (order) => { order[3].street_name = 'Different Court'; }],
    ['subdivision discovery', (order) => { order[3].subdivision = 'New Neighborhood'; }],
    ['supplied access point', (order) => { order[3].routing_access = { point: { lat: 35.1, lng: -81.1 } }; }],
    ['row locks', (order) => { order[3].order_locked = true; }],
    ['explicit locks', (_order, options) => { options.lockedStopIds = ['door-3']; }],
    ['unresolved access', (_order, options) => { options.unresolvedStopIds = ['door-3']; }],
    ['personal bounds', (_order, options) => { options.startLocation = { lat: 35.938237, lng: -81.728127 }; }],
    ['provider profile', (_order, options) => { options.vehicleProfile = 'car-alt'; }],
    ['provider identity', (_order, options) => { options.vehicleBaseUrl = 'https://other-roads.test'; }],
    ['candidate settings', (_order, options) => { options.maxLocalCandidates = 2; }],
    ['curb discovery policy', (_order, options) => { options.inferStreetSides = false; }],
    ['frozen known curb policy', (_order, options) => { options.knownDrivingAccessFor = p => ({ chainKey: p.id, side: 'right' }); }],
]) {
    test(`the scheduling key changes with ${name}`, () => {
        const order = stops(), options = {}, window = windows[0];
        const original = roadSearchWindowKey(order, window, options, policy);
        mutate(order, options);
        assert.notEqual(roadSearchWindowKey(order, window, options, policy), original);
    });
}

test('coverage contains only opaque local hashes and bounded counters, including when personal bounds are provided', () => {
    const order = stops(), options = { startLocation: { lat: 35.938237, lng: -81.728127, address: 'Private home' } };
    const state = createRoadSearchCoverage(null, policy), key = state.key(order, windows[0], options);
    state.attempt(); state.complete(key);
    const report = state.report([key]);
    assert.match(key, /^[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(report).includes('35.938237'), false);
    assert.equal(JSON.stringify(report).includes('Private home'), false);
    assert.equal(JSON.stringify(report).includes('door-'), false);
    assert.deepEqual(Object.keys(report).sort(), ['version', 'policy', 'completed_window_keys', 'total_windows',
        'remaining_windows', 'checked_this_pass', 'progress_this_pass', 'cycle_complete'].sort());
});

for (const malformed of [null, {}, { version: 2 }, { version: 1, policy, completed_window_keys: ['not-a-hash'] },
    { version: 1, policy: 'old-policy', completed_window_keys: ['a'.repeat(32)] },
    { version: 1, policy, completed_window_keys: Array(MAX_ROAD_SEARCH_COVERAGE_KEYS + 1).fill('a'.repeat(32)) }]) {
    test(`malformed or stale history is ignored safely (${JSON.stringify(malformed)?.slice(0, 65)})`, () => {
        const state = createRoadSearchCoverage(malformed, policy);
        const key = 'a'.repeat(32);
        assert.deepEqual(state.prioritize([1, 2], value => value === 1 ? key : 'b'.repeat(32)), [1, 2]);
        assert.equal(state.report([key]).completed_window_keys.length, 0);
    });
}

test('obsolete entries cannot fill the bounded ledger and prevent new local progress', () => {
    const old = Array.from({ length: MAX_ROAD_SEARCH_COVERAGE_KEYS }, (_, i) => i.toString(16).padStart(32, '0'));
    const state = createRoadSearchCoverage({ version: 1, policy, completed_window_keys: old }, policy);
    const fresh = 'f'.repeat(32);
    state.attempt(); state.complete(fresh);
    const report = state.report([fresh]);
    assert.deepEqual(report.completed_window_keys, [fresh]);
    assert.equal(report.progress_this_pass, 1);
    assert.equal(report.cycle_complete, true);
});

test('a truncated candidate loop remains pending even though its incumbent road measurement finished', async () => {
    const f = fixture({ delayBaseline: true });
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, reviewWindows: windows.slice(0, 1),
        maxLocalWindows: 1, localReviewBudgetMs: 15 });
    assert.equal(result.diagnostics.checked, 1);
    assert.equal(result.diagnostics.budgetExhausted, true);
    assert.equal(result.searchCoverage.checked_this_pass, 1);
    assert.equal(result.searchCoverage.progress_this_pass, 0);
    assert.equal(result.searchCoverage.remaining_windows, 1);
    assert.equal(result.searchCoverage.cycle_complete, false);
});

test('a provider failure on any bounded candidate cannot certify a question complete', async () => {
    const f = fixture({ failCandidate: true });
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, reviewWindows: windows.slice(0, 1) });
    assert.ok(result.diagnostics.skipped.length > 0);
    assert.equal(result.searchCoverage.progress_this_pass, 0);
    assert.equal(result.searchCoverage.remaining_windows, 1);
});

test('a fully priced coherent incumbent with no allowed changed candidate counts as considered rather than unreachable', async () => {
    const order = stops(7);
    order.forEach((p, i) => { p.routing_access = { confidence: 'high', chainKey: 'same-curb', side: 'right',
        positionMeters: i * 10, serviceBearing: 90, point: { lat: p.lat, lng: p.lng } }; });
    const cost = () => 1;
    const result = await reviewLocalDrivingNeighborhoods(order, { reviewWindows: [{ start: 2, end: 5, local: true }],
        mailCarrierMode: true, inferStreetSides: false, createLocalDrivingContext: async () => ({
            accessFor: p => p.routing_access, optimizationCostBetween: cost, distanceBetween: () => 1 / 1609.344,
            routeSequence: async sequence => makeMeasurement(sequence, cost) }) });
    assert.equal(result.properties, order);
    assert.equal(result.diagnostics.skipped.length, 0);
    assert.equal(result.searchCoverage.progress_this_pass, 1);
    assert.equal(result.searchCoverage.cycle_complete, true);
});

test('dynamic unmatched splitting retains exact healthy child questions and does not revisit the same completed child first', async () => {
    const order = stops(18), calls = [];
    const cost = () => 1;
    const options = { reviewWindows: [{ start: 2, end: 14, local: true }], maxLocalWindows: 2,
        createLocalDrivingContext: async section => {
            calls.push(ids(section));
            return { accessFor: () => null, optimizationCostBetween: cost, distanceBetween: () => 1 / 1609.344,
                routeSequence: async sequence => {
                    const bad = sequence.findIndex(p => p.id === 'door-7');
                    if (bad >= 0) throw new Error(`NoSegment: no road match for coordinate ${bad}`);
                    return makeMeasurement(sequence, cost);
                } };
        } };
    const first = await reviewLocalDrivingNeighborhoods(order, options);
    assert.equal(first.searchCoverage.total_windows, 2, 'the failed parent is replaced by two safe child questions');
    assert.equal(first.searchCoverage.checked_this_pass, 2, 'one failed parent and one healthy child were actually attempted');
    assert.equal(first.searchCoverage.progress_this_pass, 1);
    assert.equal(first.searchCoverage.remaining_windows, 1);
    const firstHealthy = calls.find(section => !section.includes('door-7')).join();
    calls.length = 0;
    const second = await reviewLocalDrivingNeighborhoods(order, { ...options, searchCoverage: first.searchCoverage });
    const secondHealthy = calls.find(section => !section.includes('door-7')).join();
    assert.notEqual(secondHealthy, firstHealthy);
    assert.equal(second.searchCoverage.completed_window_keys.length, 2);
    assert.equal(second.searchCoverage.cycle_complete, true);
    assert.deepEqual(second.properties, order);
});

test('the unchanged final neighborhood path carries coverage beside diagnostics without nesting private-bound history', async () => {
    const f = fixture();
    const result = await reviewFinalNeighborhoodRoute(f.order, { ...f.options, localDrivingReview: true });
    assert.ok(result.searchCoverage);
    assert.equal(JSON.stringify(result.diagnostics).includes('completed_window_keys'), false);
});

test('one continuation ledger retains completed main and short questions together across unchanged passes', async () => {
    const f = fixture();
    f.order.forEach((p, i) => { p.lng = -81 + Math.floor(i / 8) / 100 + [0, 7, 1, 6, 2, 5, 3, 4][i % 8] / 10000; });
    const shortWindows = planShortDrivingWindows(f.order, { ...f.options, maxShortWindows: 2 });
    assert.equal(shortWindows.length, 2);
    const options = { ...f.options, maxLocalWindows: 1, shortDrivingCleanup: true, maxShortWindows: 2 };
    const first = await reviewLocalDrivingNeighborhoods(f.order, options);
    assert.equal(first.searchCoverage.total_windows, 5);
    assert.equal(first.searchCoverage.completed_window_keys.length, 3);
    assert.equal(first.searchCoverage.remaining_windows, 2);
    const second = await reviewLocalDrivingNeighborhoods(f.order, { ...options, searchCoverage: first.searchCoverage });
    assert.equal(second.searchCoverage.completed_window_keys.length, 4);
    assert.equal(second.searchCoverage.remaining_windows, 1);
    for (const key of first.searchCoverage.completed_window_keys) assert.ok(second.searchCoverage.completed_window_keys.includes(key));
    assert.equal(second.searchCoverage.progress_this_pass, 1);
    assert.equal(JSON.stringify(second.diagnostics).includes('completed_window_keys'), false);
});
