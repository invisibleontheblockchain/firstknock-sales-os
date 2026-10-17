import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalDrivingCandidates, reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';

const stops = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, lat: 35, lng: -81 + i / 100000, street_name: 'Test Road' }));
const ids = order => order.map(stop => stop.id).join();
const original = ids(stops);
const costs = { accessFor: () => null, optimizationCostBetween: () => 1, distanceBetween: () => 0.01 };
const allProposals = buildLocalDrivingCandidates(stops, costs).filter(candidate => ids(candidate.order) !== original);
const proposals = allProposals.slice(0, 3);
// A fourth proposal exceeds the three-candidate pool, so it can only start when
// a slot frees: the guards below prove nothing new starts after a stop signal.
const four = allProposals.slice(0, 4);
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const useClock = t => t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 9, 15) });
async function drive(t, pending) {
    let settled = false, answer, failure;
    pending.then(value => { answer = value; settled = true; }, error => { failure = error; settled = true; });
    await flush();
    for (let i = 0; i < 1000 && !settled; i++) { t.mock.timers.tick(10); await flush(); }
    assert.equal(settled, true, 'bounded synthetic review must finish');
    if (failure) throw failure;
    return answer;
}
function fixture({ delays = [], fail, improve = false } = {}) {
    const calls = [], finished = [];
    let inFlight = 0, peak = 0;
    const context = { ...costs, async routeSequence(order) {
        const index = calls.length; calls.push(ids(order));
        inFlight++; peak = Math.max(peak, inFlight);
        try {
            await new Promise(resolve => setTimeout(resolve, delays[index] ?? 100));
            if (fail?.[index]) throw new Error(fail[index]);
            const seconds = improve && ids(order) === original ? 1000 : 100;
            const directedLegs = order.slice(1).map((stop, i) => ({ from: order[i].id, to: stop.id,
                pathKey: `${order[i].id}>${stop.id}`, driveSeconds: seconds / (order.length - 1), distanceMiles: 1 / (order.length - 1) }));
            finished.push(index);
            return { driveSeconds: seconds, distanceMiles: 1, estimatedTurnarounds: 0, directedLegs };
        } finally { inFlight--; }
    } };
    return { calls, finished, context, active: () => inFlight, peak: () => peak,
        run: (options = {}) => reviewLocalDrivingNeighborhoods(stops, {
            areaDrivingReview: false, reviewWindows: [{ start: 0, end: stops.length }], maxLocalCandidates: 3,
            localReviewBudgetMs: 1000, createLocalDrivingContext: async () => context, ...options,
        }) };
}

test('the same three candidate questions take one latency wave with at most three in flight', async t => {
    useClock(t);
    const f = fixture(), started = Date.now();
    const result = await drive(t, f.run());
    assert.deepEqual(f.calls, [original, ...proposals.map(candidate => ids(candidate.order))]);
    assert.equal(f.peak(), 3); assert.equal(f.active(), 0);
    assert.equal(Date.now() - started, 200, 'baseline 100ms plus one candidate wave, versus 400ms sequential');
    assert.equal(result.diagnostics.candidatesMeasured, 3);
    assert.deepEqual(result.properties, stops);
    assert.equal(result.searchCoverage.cycle_complete, true);
    assert.equal(result.diagnostics.timings.road_context_ms, 100);
    assert.equal(result.diagnostics.timings.candidate_measurement_ms, 100);
    assert.equal(result.diagnostics.timings.total_ms, 200);
});

test('out-of-order responses retain the original candidate tie order and complete-route proof', async t => {
    useClock(t);
    const f = fixture({ delays: [100, 100, 10], improve: true });
    const result = await drive(t, f.run());
    assert.ok(f.finished.indexOf(2) < f.finished.indexOf(1), 'second candidate actually completes first');
    assert.equal(ids(result.properties), ids(proposals[0].order), 'first candidate retains the equal-cost tie');
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.candidatesMeasured, 3);
    assert.deepEqual(f.calls.slice(1, 4), proposals.map(candidate => ids(candidate.order)));
    assert.deepEqual(f.calls.slice(4), [original, ids(proposals[0].order)], 'the complete original and winner still get measured');
    assert.equal(f.peak(), 3);
});

test('a fatal candidate failure drains its peers and cannot schedule another candidate', async t => {
    useClock(t);
    const f = fixture({ delays: [100, 100, 10], fail: { 2: 'Provider graph identity changed' } });
    await assert.rejects(drive(t, f.run({ maxLocalCandidates: 4 })), /graph identity changed/);
    assert.deepEqual(f.calls, [original, ...four.slice(0, 3).map(candidate => ids(candidate.order))]);
    assert.equal(f.active(), 0); assert.equal(f.peak(), 3);
});

test('cancellation drains started candidate work and cannot schedule another batch', async t => {
    useClock(t);
    const controller = new AbortController(), f = fixture();
    const pending = f.run({ signal: controller.signal, maxLocalCandidates: 4 });
    await flush(); t.mock.timers.tick(100); await flush();
    assert.equal(f.calls.length, 4);
    controller.abort(new Error('Review cancelled'));
    await assert.rejects(drive(t, pending), /cancelled/);
    assert.equal(f.calls.length, 4, 'the fourth proposal never starts'); assert.equal(f.active(), 0);
});

test('an expired window deadline never launches another candidate batch or marks partial work complete', async t => {
    useClock(t);
    const f = fixture();
    const result = await drive(t, f.run({ localReviewBudgetMs: 150, maxLocalCandidates: 4 }));
    assert.equal(f.calls.length, 4, 'three started before the deadline; the fourth never starts');
    assert.equal(result.diagnostics.candidatesMeasured, 3);
    assert.equal(result.diagnostics.budgetExhausted, true);
    assert.equal(result.searchCoverage.cycle_complete, false);
    assert.equal(result.searchCoverage.remaining_windows, 1);
    assert.deepEqual(result.properties, stops);
});

test('ordinary candidate failures keep their coverage incomplete while other existing proposals are checked', async t => {
    useClock(t);
    const f = fixture({ fail: { 1: 'Provider temporarily unavailable' }, improve: true });
    const result = await drive(t, f.run());
    assert.equal(f.calls.length, 6); assert.equal(f.active(), 0);
    assert.deepEqual(f.calls.slice(1, 4), proposals.map(candidate => ids(candidate.order)));
    assert.equal(result.diagnostics.candidatesMeasured, 2);
    assert.equal(result.diagnostics.skipped.length, 1);
    assert.equal(result.diagnostics.skipped[0].candidate, true);
    assert.equal(result.searchCoverage.cycle_complete, false);
    assert.equal(ids(result.properties), ids(proposals[1].order), 'the valid peer wins and still passes complete-route verification');
    assert.equal(result.diagnostics.validation, 'whole_route');
});

test('a freed slot starts the next candidate at once, still with at most three in flight', async t => {
    useClock(t);
    // Baseline 100 ms; the second candidate returns in 10 ms, so the fourth
    // starts at 110 ms instead of waiting for the whole first wave at 200 ms.
    const f = fixture({ delays: [100, 100, 10, 100, 100] }), started = Date.now();
    const result = await drive(t, f.run({ maxLocalCandidates: 4 }));
    assert.equal(f.peak(), 3);
    assert.equal(Date.now() - started, 210, 'versus 300 ms when each wave must fully return');
    assert.equal(result.diagnostics.candidatesMeasured, 4);
    assert.deepEqual(f.calls.slice(1, 5), four.map(candidate => ids(candidate.order)));
});
