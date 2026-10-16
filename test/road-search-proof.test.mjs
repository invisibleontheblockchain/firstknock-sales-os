import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoadSearchProof, validateRoadSearchProofSnapshot, isRoadSearchProof,
    MAX_ROAD_SEARCH_PROOF_STOPS, MAX_ROAD_SEARCH_PROOF_RECEIPTS } from '../base44/shared/roadSearchProof.js';
import { createRoadSearchCoverage } from '../base44/shared/roadSearchCoverage.js';
import { reviewLocalDrivingNeighborhoods, LOCAL_DRIVING_REVIEW_VERSION } from '../base44/shared/localDrivingNeighborhoods.js';
import { verifyCompleteDrivingCandidate } from '../base44/shared/completeDrivingVerification.js';

const scope = { providerIdentity: 'https://roads.test|driving|graph-1', policyVersion: 'test-policy-1' };
const makeProof = snapshot => createRoadSearchProof(snapshot, scope);
const windows = [{ start: 2, end: 5, local: true }, { start: 9, end: 12, local: true }, { start: 16, end: 19, local: true }];
const stops = size => Array.from({ length: size }, (_, i) => ({ id: `door-${i}`, rank: i,
    lat: 35, lng: -81, house_number: String(100 + i), street_name: 'Proof Lane', city: 'Test City', state: 'NC' }));
const access = stop => ({ confidence: 'high', chainKey: 'proof-chain', side: 'right', positionMeters: stop.rank * 10,
    point: { lat: stop.lat, lng: stop.lng }, serviceBearing: 90, source: 'osrm-named-road-side', roadName: 'Proof Lane' });
const ids = order => order.map(stop => stop.id);
function measurement(order, cost) {
    const directedLegs = order.slice(1).map((stop, i) => ({ from: order[i].id, to: stop.id,
        pathKey: `${order[i].id}>${stop.id}`, driveSeconds: cost(order[i], stop), distanceMiles: cost(order[i], stop) / 1609.344,
        geometry: [order[i], stop].map(({ lat, lng }) => ({ lat, lng })), turnarounds: 0 }));
    return { directedLegs, driveSeconds: directedLegs.reduce((sum, leg) => sum + leg.driveSeconds, 0),
        distanceMiles: directedLegs.reduce((sum, leg) => sum + leg.distanceMiles, 0), dataVersion: 'graph-1',
        estimatedTurnarounds: 0, geometry: order.map(({ lat, lng }) => ({ lat, lng })) };
}
function fixture({ improve = false, failCandidate = false, delayBaseline = false, retryHeading = false } = {}) {
    const order = stops(24), calls = [], proof = makeProof();
    if (improve) [order[3], order[4]] = [order[4], order[3]];
    const cost = (a, b) => improve ? b.rank === a.rank + 1 ? 1 : 20 + Math.abs(b.rank - a.rank) : 1;
    const options = { reviewWindows: windows, areaDrivingReview: false, maxLocalWindows: 3, localReviewBudgetMs: 5000,
        roadSearchProof: proof,
        createLocalDrivingContext: async (section, config) => {
            calls.push({ kind: 'context', ids: ids(section), config });
            return { accessFor: stop => proof.inferredAccess.get(stop.id) || stop.routing_access,
                optimizationCostBetween: cost, distanceBetween: (a, b) => cost(a, b) / 1609.344,
                async routeSequence(sequence) {
                    const baseline = ids(sequence).join() === ids(section).join();
                    calls.push({ kind: 'route', ids: ids(sequence), baseline });
                    if (retryHeading && proof.inferredAccess.has('door-3')) {
                        throw new Error(`NoSegment: no road match for coordinate ${sequence.findIndex(p => p.id === 'door-3')}`);
                    }
                    if (failCandidate && !baseline) throw new Error('Road provider unavailable.');
                    if (delayBaseline && baseline) await new Promise(resolve => setTimeout(resolve, 20));
                    return measurement(sequence, cost);
                } };
        } };
    return { order, calls, proof, options };
}

test('certified unchanged windows consume no table or route calls on continuation and fresh limits still count fresh work', async () => {
    const f = fixture();
    const first = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalWindows: 1 });
    assert.equal(first.searchCoverage.remaining_windows, 2);
    assert.equal(f.proof.exportSnapshot().receipts.length, 1);
    assert.match(first.searchCoverage.completed_window_keys[0], /^[a-f0-9]{64}$/);
    const previouslyMeasured = f.calls.find(call => call.kind === 'context').ids.join();
    f.calls.length = 0;
    const second = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalWindows: 2,
        searchCoverage: first.searchCoverage });
    assert.equal(second.diagnostics.checked, 2);
    assert.equal(second.diagnostics.reused, 1);
    assert.equal(second.searchCoverage.checked_this_pass, 2);
    assert.equal(second.searchCoverage.progress_this_pass, 2);
    assert.equal(second.searchCoverage.cycle_complete, true);
    assert.ok(f.calls.every(call => call.ids.join() !== previouslyMeasured));
    f.calls.length = 0;
    const third = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, searchCoverage: second.searchCoverage });
    assert.equal(third.diagnostics.checked, 0);
    assert.equal(third.diagnostics.reused, 3);
    assert.equal(third.searchCoverage.progress_this_pass, 0);
    assert.equal(third.searchCoverage.cycle_complete, true);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(third.properties, f.order);
});

test('unsigned claimed completion cannot certify any question in proof mode', async () => {
    const f = fixture();
    const first = await reviewLocalDrivingNeighborhoods(f.order, f.options);
    const second = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, roadSearchProof: makeProof(),
        maxLocalWindows: 0, searchCoverage: first.searchCoverage });
    assert.equal(second.searchCoverage.completed_window_keys.length, 0);
    assert.equal(second.searchCoverage.remaining_windows, 3);
    assert.equal(second.searchCoverage.cycle_complete, false);
    const state = createRoadSearchCoverage(first.searchCoverage, LOCAL_DRIVING_REVIEW_VERSION, { certified: true });
    state.attempt(); state.complete(first.searchCoverage.completed_window_keys[0]);
    assert.equal(state.report(first.searchCoverage.completed_window_keys).progress_this_pass, 1,
        'unsigned hints cannot suppress freshly measured progress either');
});

test('changing effective inference invalidates only affected sections', async () => {
    const f = fixture();
    await reviewLocalDrivingNeighborhoods(f.order, f.options);
    const before = f.proof.exportSnapshot().receipts;
    f.proof.inferredAccess.set('door-10', access(f.order[10]));
    f.proof.discovered.add('door-10');
    f.calls.length = 0;
    const next = await reviewLocalDrivingNeighborhoods(f.order, f.options);
    assert.equal(next.diagnostics.checked, 1);
    assert.equal(next.diagnostics.reused, 2);
    assert.equal(f.calls.filter(call => call.kind === 'context').length, 1);
    assert.equal(f.proof.exportSnapshot().receipts.filter(key => before.includes(key)).length, 2);
});

test('changed order and locks invalidate their receipts without replaying a stored route move', async () => {
    const f = fixture();
    await reviewLocalDrivingNeighborhoods(f.order, f.options);
    const changed = [...f.order]; [changed[3], changed[4]] = [changed[4], changed[3]];
    const next = await reviewLocalDrivingNeighborhoods(changed, { ...f.options, maxLocalWindows: 0 });
    assert.equal(next.searchCoverage.remaining_windows, 1);
    assert.equal(f.proof.exportSnapshot().receipts.length, 2);
    assert.deepEqual(next.properties, changed);
    const locked = await reviewLocalDrivingNeighborhoods(changed, { ...f.options, maxLocalWindows: 0, lockedStopIds: ['door-10'] });
    assert.equal(locked.searchCoverage.remaining_windows, 2);
    assert.equal(f.proof.exportSnapshot().receipts.length, 1);
});

test('a changed winning window never becomes a reusable unchanged-window receipt', async () => {
    const f = fixture({ improve: true });
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, reviewWindows: windows.slice(0, 1) });
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.deepEqual(result.properties.map(p => p.rank), Array.from({ length: 24 }, (_, i) => i));
    assert.equal(f.proof.exportSnapshot().receipts.length, 0);
    assert.equal(result.searchCoverage.remaining_windows, 1);
});

for (const [label, behavior, budget] of [['provider failure', { failCandidate: true }, 5000],
    ['deadline', { delayBaseline: true }, 5]]) {
    test(`${label} cannot produce a reusable completed receipt`, async () => {
        const f = fixture(behavior);
        const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, reviewWindows: windows.slice(0, 1),
            localReviewBudgetMs: budget });
        assert.equal(f.proof.exportSnapshot().receipts.length, 0);
        assert.equal(result.searchCoverage.cycle_complete, false);
    });
}

test('heading retry certifies the post-retry policy and deleting an old heading invalidates its key', async () => {
    const f = fixture({ retryHeading: true });
    f.proof.inferredAccess.set('door-3', access(f.order[3])); f.proof.discovered.add('door-3');
    await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, reviewWindows: windows.slice(0, 1) });
    assert.equal(f.proof.inferredAccess.has('door-3'), false);
    assert.equal(f.proof.exportSnapshot().receipts.length, 1);
    f.calls.length = 0;
    const again = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, reviewWindows: windows.slice(0, 1) });
    assert.equal(again.diagnostics.reused, 1);
    assert.equal(f.calls.length, 0);
    const g = fixture();
    g.proof.inferredAccess.set('door-3', access(g.order[3])); g.proof.discovered.add('door-3');
    await reviewLocalDrivingNeighborhoods(g.order, { ...g.options, reviewWindows: windows.slice(0, 1) });
    const oldKey = g.proof.exportSnapshot().receipts[0];
    g.proof.inferredAccess.delete('door-3');
    const fresh = await reviewLocalDrivingNeighborhoods(g.order, { ...g.options, reviewWindows: windows.slice(0, 1) });
    assert.equal(fresh.diagnostics.checked, 1);
    assert.equal(fresh.diagnostics.reused, 0);
    assert.ok(!g.proof.exportSnapshot().receipts.includes(oldKey));
});

test('unknown discovery observations survive a restored action and do not trigger repeated discovery', async () => {
    const f = fixture();
    const options = { ...f.options, mailCarrierMode: true, reviewWindows: windows.slice(0, 1) };
    await reviewLocalDrivingNeighborhoods(f.order, options);
    assert.equal(f.calls.filter(call => call.kind === 'context' && call.config.discoverStreetSides).length, 1);
    const restored = makeProof(f.proof.exportSnapshot());
    assert.equal(restored.discovered.size, 7);
    assert.equal(restored.inferredAccess.size, 0);
    f.calls.length = 0;
    const again = await reviewLocalDrivingNeighborhoods(f.order, { ...options, roadSearchProof: restored });
    assert.equal(again.diagnostics.reused, 1);
    assert.equal(f.calls.length, 0);
});

test('personal bounds are bound by the question digest without entering the carried inference inventory', async () => {
    const f = fixture();
    const options = { ...f.options, mailCarrierMode: true, reviewWindows: [{ start: 0, end: 3, local: true }],
        startLocation: { id: 'personal-origin', lat: 35.001234, lng: -81.004321 } };
    await reviewLocalDrivingNeighborhoods(f.order, options);
    const snapshot = f.proof.exportSnapshot();
    assert.equal(snapshot.discovered.includes('personal-origin'), false);
    assert.equal(JSON.stringify(snapshot).includes('35.001234'), false);
    f.calls.length = 0;
    const again = await reviewLocalDrivingNeighborhoods(f.order, options);
    assert.equal(again.diagnostics.checked, 0);
    assert.equal(again.diagnostics.reused, 1);
    assert.equal(f.calls.length, 0);
});

test('shared main and short phases retain distinct receipts using the actual carried access policy', async () => {
    const f = fixture();
    f.order.forEach((p, i) => { p.lng = -81 + Math.floor(i / 8) / 100 + [0, 7, 1, 6, 2, 5, 3, 4][i % 8] / 10000; });
    const options = { ...f.options, shortDrivingCleanup: true, maxShortWindows: 2 };
    const first = await reviewLocalDrivingNeighborhoods(f.order, options);
    assert.equal(first.searchCoverage.total_windows, 5);
    assert.equal(first.searchCoverage.cycle_complete, true);
    assert.equal(f.proof.exportSnapshot().receipts.length, 5);
    f.calls.length = 0;
    const second = await reviewLocalDrivingNeighborhoods(f.order, options);
    assert.equal(second.diagnostics.reused, 5);
    assert.equal(second.diagnostics.checked, 0);
    assert.equal(second.searchCoverage.cycle_complete, true);
    assert.equal(f.calls.length, 0);
});

test('377 stops revisit only changed questions instead of spending the next 64-window allowance on completed work', async t => {
    const f = fixture(), order = stops(377);
    const reviewWindows = Array.from({ length: 121 }, (_, i) => ({ start: 2 + i * 3, end: 5 + i * 3, local: true }));
    const options = { ...f.options, reviewWindows, maxLocalWindows: 100 };
    const first = await reviewLocalDrivingNeighborhoods(order, options);
    assert.equal(first.searchCoverage.remaining_windows, 21);
    const second = await reviewLocalDrivingNeighborhoods(order, { ...options, searchCoverage: first.searchCoverage });
    assert.equal(second.searchCoverage.cycle_complete, true);
    assert.equal(second.diagnostics.checked, 21);
    assert.equal(second.diagnostics.reused, 100);
    const changed = structuredClone(order); changed[170].lat += 0.000001;
    f.calls.length = 0;
    const resumed = await reviewLocalDrivingNeighborhoods(changed, { ...options, maxLocalWindows: 64,
        searchCoverage: second.searchCoverage });
    const reusedCalls = f.calls.filter(call => call.kind === 'route').length;
    assert.equal(resumed.diagnostics.checked, 2);
    assert.equal(resumed.diagnostics.reused, 119);
    assert.equal(resumed.searchCoverage.cycle_complete, true);
    assert.deepEqual(resumed.properties, changed);
    f.calls.length = 0;
    const fresh = await reviewLocalDrivingNeighborhoods(changed, { ...options, roadSearchProof: null, maxLocalWindows: 64 });
    const freshCalls = f.calls.filter(call => call.kind === 'route').length;
    assert.equal(fresh.diagnostics.checked, 64);
    assert.deepEqual(fresh.properties, resumed.properties);
    assert.equal(reusedCalls, 8);
    assert.equal(freshCalls, 256);
    t.diagnostic(`377-stop continuation: ${reusedCalls} local route calls versus ${freshCalls}; 119 unchanged questions reused, 2 freshly checked.`);
});

test('short-phase heading removal invalidates retained main measurements and forces complete remeasurement', async () => {
    const positions = [0, 0.1, 3, 2.5, 1, 4, 4.5, 20, 20.1, 23, 22.5, 21, 24, 24.5];
    const order = positions.map((p, i) => ({ id: `door-${i}`, rank: i, street_name: 'Proof Lane', lat: 35 + p / 1000, lng: -81 }));
    const major = [...order]; major.splice(2, 3, order[4], order[3], order[2]);
    const edges = new Set(major.slice(1).map((p, i) => `${major[i].id}>${p.id}`));
    const cost = (a, b) => edges.has(`${a.id}>${b.id}`) ? 1 : 50;
    const proof = makeProof(); proof.inferredAccess.set('door-9', access(order[9])); proof.discovered.add('door-9');
    let retried = false;
    const result = await reviewLocalDrivingNeighborhoods(order, { roadSearchProof: proof,
        reviewWindows: [{ start: 2, end: 5, local: true }], maxLocalWindows: 1, areaDrivingReview: false,
        shortDrivingCleanup: true, maxShortWindows: 1,
        createLocalDrivingContext: async (section, config) => ({ accessFor: p => proof.inferredAccess.get(p.id),
            optimizationCostBetween: cost, distanceBetween: (a, b) => cost(a, b) / 1609.344,
            routeSequence: async sequence => {
                const bad = sequence.findIndex(p => p.id === 'door-9');
                if (config.inferStreetSides === false && proof.inferredAccess.has('door-9') && bad >= 0) {
                    retried = true; throw new Error(`NoSegment: no road match for coordinate ${bad}`);
                }
                return measurement(sequence, cost);
            } }) });
    assert.equal(retried, true);
    assert.equal(proof.inferredAccess.has('door-9'), false);
    assert.deepEqual(result.properties, major);
    assert.equal(result.measurement, undefined);
    assert.equal(result.baseline, undefined);
    let freshCalls = 0;
    const verified = await verifyCompleteDrivingCandidate({ baselineOrder: order, candidateOrder: result.properties,
        neighborhood: { ...result, diagnostics: { local_driving_review: result.diagnostics } },
        options: { createDrivingContext: async () => ({ routeSequence: async sequence => {
            freshCalls++; return measurement(sequence, cost);
        } }) } });
    assert.equal(freshCalls, 2);
    assert.deepEqual(verified.properties, major);
    assert.equal(verified.measurement.directedLegs.length, order.length - 1);
});

test('semantic SHA key binds boundaries, candidate policy, provider scope and effective access', async () => {
    const proof = makeProof(), order = stops(24), base = await proof.key(order, windows[0]);
    assert.match(base, /^[a-f0-9]{64}$/);
    for (const options of [{ startLocation: { lat: 35.12, lng: -81.2 } }, { maxLocalCandidates: 2 },
        { lockedStopIds: ['door-3'] }, { knownDrivingAccessFor: stop => access(stop) },
        { servicePolicy: { walkingMetersPerSecond: 2 } }]) {
        assert.notEqual(await proof.key(order, windows[0], options), base);
    }
    const other = createRoadSearchProof(null, { ...scope, providerIdentity: 'other-provider' });
    assert.notEqual(await other.key(order, windows[0]), base);
    proof.discovered.add('door-22');
    assert.equal(await proof.key(order, windows[0]), base, 'unrelated discovered state must not invalidate this question');
});

test('snapshot validation is bounded and restoration defensively copies authenticated state', async () => {
    const proof = makeProof(); proof.inferredAccess.set('door-3', access(stops(4)[3])); proof.discovered.add('door-3');
    proof.complete('a'.repeat(64));
    const snapshot = proof.exportSnapshot(), restored = makeProof(snapshot);
    snapshot.inferredAccess[0][1].side = 'left'; snapshot.discovered.push('changed'); snapshot.receipts.length = 0;
    assert.equal(restored.inferredAccess.get('door-3').side, 'right');
    assert.equal(restored.discovered.has('changed'), false);
    assert.equal(restored.has('a'.repeat(64)), true);
    assert.equal(isRoadSearchProof(restored), true);
    assert.equal(isRoadSearchProof({ ...restored }), false);
    const good = restored.exportSnapshot();
    for (const invalid of [{ ...good, version: 2 }, { ...good, receipts: ['f'.repeat(32)] },
        { ...good, discovered: Array.from({ length: MAX_ROAD_SEARCH_PROOF_STOPS + 1 }, (_, i) => String(i)) },
        { ...good, receipts: Array.from({ length: MAX_ROAD_SEARCH_PROOF_RECEIPTS + 1 }, (_, i) => i.toString(16).padStart(64, '0')) },
        { ...good, inferredAccess: [['door-3', { ...access(stops(4)[3]), serviceBearing: NaN }]] },
        { ...good, receipts: ['a'.repeat(64), 'a'.repeat(64)] }]) {
        assert.equal(validateRoadSearchProofSnapshot(invalid), null);
        assert.throws(() => makeProof(invalid));
    }
    assert.throws(() => createRoadSearchProof(good, { ...scope, policyVersion: 'changed-policy' }));
    await assert.rejects(reviewLocalDrivingNeighborhoods(stops(3), { roadSearchProof: { ...restored } }), /authenticated endpoint/);
});
