import test from 'node:test';
import assert from 'node:assert/strict';
import { planGuardedDrivingWindows, optimizeGuardedDrivingWindows,
    evaluateDrivingWindow, summarizeStitchedDrivingLegs, measureUnchangedDrivingLegs } from '../base44/shared/guardedDrivingWindows.js';

const stops = Array.from({ length: 20 }, (_, i) => ({ address_hash: String(i), lat: 35 + i / 10000, lng: -81 }));
const partitionRun = (run, limit) => Array.from({ length: Math.ceil(run.length / limit) }, (_, i) => run.slice(i * limit, (i + 1) * limit));
const plan = () => planGuardedDrivingWindows(stops, { unresolvedIds: ['7', '16'], maxWindowStops: 8, partitionRun });
function scorer(source, { costlyConnector = false, contextChanged = false } = {}) {
    return { vehicleAware: true, routeSequence: async sequence => {
        const changed = sequence.map(p => p.address_hash).join('|') !== source.map(p => p.address_hash).join('|');
        const directedLegs = sequence.slice(1).map((p, i) => ({ from: sequence[i].address_hash, to: p.address_hash,
            driveSeconds: changed ? costlyConnector && i === 1 ? 1000 : 5 : 20,
            distanceMiles: changed ? costlyConnector && i === 1 ? 1000 : 1 : 4,
            pathKey: `${sequence[i].address_hash}>${p.address_hash}` }));
        // Outside context legs stay identical unless deliberately testing a bug.
        if (changed && !contextChanged) for (const i of [0, directedLegs.length - 1]) {
            directedLegs[i].driveSeconds = 20; directedLegs[i].distanceMiles = 4;
        }
        return { directedLegs, driveSeconds: directedLegs.reduce((s, l) => s + l.driveSeconds, 0),
            distanceMiles: directedLegs.reduce((s, l) => s + l.distanceMiles, 0), dataVersion: 'frozen-map' };
    } };
}
const propose = interior => [...interior].reverse();
const options = () => ({ createContext: async source => scorer(source), propose, providerEpoch: 'immutable-build', expectedDataVersion: 'frozen-map' });
test('unknown anchors keep their exact indices and windows preserve their real approach/departure context', async () => {
    const p = plan();
    assert.equal(p.windows.length, 2);
    assert.equal(p.windows.every(w => w.end - w.start <= 8), true);
    const output = await optimizeGuardedDrivingWindows(stops, p, options());
    assert.equal(output.summary.visibleRoutes, 1);
    assert.equal(output.summary.improvedWindows, 2);
    for (const i of [7, 16]) assert.equal(output.properties[i], stops[i]);
    for (const w of p.windows) for (const i of [w.start, w.start + 1, w.end - 2, w.end - 1]) assert.equal(output.properties[i], stops[i]);
    assert.deepEqual(output.properties.map(p => p.address_hash).sort(), stops.map(p => p.address_hash).sort());
});
test('a cheap interior cannot hide worse connectors or changed outer driving context', async () => {
    const w = plan().windows[0];
    for (const scenario of [{ costlyConnector: true }, { contextChanged: true }]) {
        const result = await evaluateDrivingWindow(stops, w, { createContext: async source => scorer(source, scenario), propose });
        assert.equal(result.selection, 'legacy_guard');
        assert.deepEqual(result.selectedIds, w.sourceOrder);
    }
});
test('every seam is counted exactly once and unknown directed legs stay unchanged and explicitly missing', async () => {
    const output = await optimizeGuardedDrivingWindows(stops, plan(), options());
    const unchanged = await measureUnchangedDrivingLegs(stops, output, { unresolvedIds: ['7', '16'],
        measureSequence: async sequence => scorer(sequence).routeSequence(sequence) });
    const summary = summarizeStitchedDrivingLegs(stops, output, unchanged);
    assert.equal(summary.expectedLegs, 19);
    assert.equal(summary.measuredLegs, 15);
    assert.deepEqual(summary.unmeasurableLegIndexes, [6, 7, 15, 16]);
    assert.equal(summary.fullRoadTotalAvailable, false);
    assert.ok(summary.milesSaved > 0);
    assert.ok(summary.secondsSaved > 0);
    await assert.rejects(async () => summarizeStitchedDrivingLegs(stops, output, [...unchanged, unchanged.find(r => r.leg)]), /twice/);
});
test('checkpoint resumes without reoptimizing completed windows and rejects changed graph, coordinates or anchors', async () => {
    let checkpoint;
    const p = plan();
    const first = await optimizeGuardedDrivingWindows(stops, p, { ...options(), onCheckpoint: state => { checkpoint = structuredClone(state); } });
    const resumed = await optimizeGuardedDrivingWindows(stops, p, { ...options(), resume: checkpoint,
        createContext: () => { throw new Error('completed windows must resume'); } });
    assert.deepEqual(resumed.properties, first.properties);
    await assert.rejects(optimizeGuardedDrivingWindows(stops, p, { ...options(), providerEpoch: 'new-build', resume: checkpoint }), /graph identity/);
    const moved = stops.map(p => ({ ...p })); moved[3].lng += 0.01;
    await assert.rejects(optimizeGuardedDrivingWindows(moved, p, options()), /coordinates/);
    const corrupt = structuredClone(checkpoint); corrupt.results[0].selectedIds.reverse();
    await assert.rejects(optimizeGuardedDrivingWindows(stops, p, { ...options(), resume: corrupt }), /anchor/);
});
test('a provider outage stops further window requests and preserves legacy without fabricating measurements', async () => {
    let requests = 0;
    const result = await optimizeGuardedDrivingWindows(stops, plan(), { ...options(), createContext: async () => {
        requests++; throw new Error('Vehicle routing failed (503)'); } });
    assert.equal(requests, 1);
    assert.deepEqual(result.properties, stops);
    assert.equal(result.summary.roadAwareStops, 0);
    assert.equal(result.results.every(r => r.selected === null), true);
});
