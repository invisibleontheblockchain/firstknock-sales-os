import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDrivingAreaCandidates, planDrivingAreaWindows } from '../base44/shared/drivingAreaRouting.js';
import { mailCarrierPassViolations } from '../base44/shared/mailCarrierRouting.js';

const door = (id, street_name = `Street ${id}`) => ({ address_hash: String(id), street_name,
    city: 'Test Town', zip_code: '00000', lat: 35.65 + Number(id) * 0.000001, lng: -80.9 });
const ids = order => order.map(p => p.address_hash);
const directedContext = (preferred, options = {}) => {
    const edges = new Set(preferred.slice(1).map((p, i) => `${preferred[i].address_hash}>${p.address_hash}`));
    const calls = { seconds: 0, miles: 0 };
    const cost = (a, b) => edges.has(`${a.address_hash}>${b.address_hash}`) ? 1
        : edges.has(`${b.address_hash}>${a.address_hash}`) ? 200 : 80;
    return { calls, accessFor: p => p.routing_access,
        optimizationCostBetween(a, b) { calls.seconds++; return options.unavailable ? Infinity : cost(a, b); },
        distanceBetween(a, b) { calls.miles++; return options.unavailable ? Infinity : cost(a, b) / 100; },
        duration: order => order.slice(1).reduce((s, p, i) => s + cost(order[i], p), 0),
        distance: order => order.slice(1).reduce((s, p, i) => s + cost(order[i], p) / 100, 0),
    };
};

test('larger overlapping windows contain a complete twelve-stop area beyond a ten-door search', () => {
    const order = Array.from({ length: 80 }, (_, i) => door(i));
    const windows = planDrivingAreaWindows(order);
    assert.ok(windows.some(w => w.start <= 42 && w.end >= 54));
    assert.ok(windows.every(w => w.area === true && w.end - w.start <= 40));
    assert.ok(windows.some((w, i) => i > 0 && w.start < windows[i - 1].end));
    assert.deepEqual(planDrivingAreaWindows(order), windows);
    const capped = planDrivingAreaWindows(order, { maxAreaWindowStops: 500 });
    assert.ok(capped.every(w => w.end - w.start <= 40));
});

test('window discovery crosses different labels without claiming roads connect across a geographic barrier', () => {
    const order = Array.from({ length: 12 }, (_, i) => ({ ...door(i), subdivision_name: `Unrelated label ${i}` }));
    const windows = planDrivingAreaWindows(order);
    assert.ok(windows.some(w => w.start === 0 && w.end === 12));
    assert.ok(windows.every(w => !('connected' in w) && !('secondsSaved' in w) && !('areaReturns' in w)));
    const context = directedContext(order, { unavailable: true });
    assert.deepEqual(buildDrivingAreaCandidates(order, context), [], 'unavailable roads must not use the geometric discovery cost');
});

test('whole lower visit can move behind several upper streets with no shared neighborhood label', () => {
    const lower = Array.from({ length: 3 }, (_, i) => door(306 + i, 'Lower approach'));
    const upper = Array.from({ length: 9 }, (_, i) => door(309 + i, `Upper branch ${Math.floor(i / 3)}`));
    const stops = [...lower, ...upper], start = door(305), end = door(318);
    const desired = [...upper, ...lower], context = directedContext([start, ...desired, end]);
    const candidates = buildDrivingAreaCandidates(stops, context, start, end);
    assert.deepEqual(ids(candidates[0].order), ids(desired));
    assert.ok(candidates[0].seconds < context.duration([start, ...stops, end]));
    assert.deepEqual(new Set(candidates[0].order), new Set(stops));
    for (const candidate of candidates) {
        assert.equal(candidate.seconds, context.duration([start, ...candidate.order, end]));
        assert.ok(Math.abs(candidate.miles - context.distance([start, ...candidate.order, end])) < 1e-9);
        for (const street of new Set(stops.map(p => p.street_name))) {
            assert.deepEqual(ids(candidate.order.filter(p => p.street_name === street)), ids(stops.filter(p => p.street_name === street)));
        }
    }
    assert.equal(context.calls.seconds, 14 * 13, 'directed metrics are prepriced once instead of read for every move');
    assert.equal(context.calls.miles, 14 * 13);
});

test('recorded Troutman road costs rank the user requested complete upper-area visit first', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/troutman-area-305-317.json', import.meta.url), 'utf8'));
    const index = p => fixture.matrix.order.indexOf(p.stop);
    const context = { accessFor: p => p.routing_access,
        optimizationCostBetween: (a, b) => fixture.matrix.durations[index(a)][index(b)],
        distanceBetween: (a, b) => fixture.matrix.distances[index(a)][index(b)],
    };
    const stops = fixture.stops.filter(p => p.stop >= 306 && p.stop <= 317);
    const candidates = buildDrivingAreaCandidates(stops, context, fixture.stops[1], fixture.stops.at(-2));
    const desired = fixture.expected.order.filter(n => n >= 306 && n <= 317);
    assert.deepEqual(candidates[0].order.map(p => p.stop), desired);
    assert.equal(candidates[0].areaMove, true);
    assert.equal(mailCarrierPassViolations(candidates[0].order, context), 0);
    // These are fixed curb/approach measurements of the entire local continuous
    // drive, not sums of matrix edges or whole 377-stop-route savings.
    assert.equal(fixture.measurements.after.boundariesMatch, true);
    assert.ok(fixture.measurements.after.distanceMiles < fixture.measurements.before.distanceMiles);
    assert.ok(fixture.measurements.after.driveSeconds < fixture.measurements.before.driveSeconds);
});

test('a short western approach cannot hide the entrance to the complete unlocked Troutman area', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/troutman-area-305-317.json', import.meta.url), 'utf8'));
    const order = fixture.stops;
    assert.ok(order.every(p => !p.locked && !p.order_locked));
    const first = order.findIndex(p => p.stop === 306), last = order.findIndex(p => p.stop === 317);
    const windows = planDrivingAreaWindows(order);
    assert.ok(windows.some(w => w.start <= first && w.end > last));
    assert.ok(windows.some(w => w.start === first), 'seed the next street entrance even after a short radius-clipped western window');
    assert.ok(windows.every((w, i) => i === 0 || w.end > windows[i - 1].end), 'fully contained area questions are removed');
    assert.deepEqual(planDrivingAreaWindows(Array.from({ length: 80 }, (_, i) => door(i, 'One long street'))), []);
});

test('a genuine asymmetric road pivot is retained by the caller improvement guard', () => {
    const lower = Array.from({ length: 3 }, (_, i) => door(i, 'Lower street'));
    const upper = Array.from({ length: 9 }, (_, i) => door(i + 3, `Upper street ${Math.floor(i / 3)}`));
    const stops = [...lower, ...upper], start = door(30), end = door(31);
    const context = directedContext([start, ...stops, end]);
    const candidates = buildDrivingAreaCandidates(stops, context, start, end);
    const incumbentSeconds = context.duration([start, ...stops, end]);
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(c => c.seconds > incumbentSeconds), 'upper-first geometry must not override cheaper directed road costs');
    assert.equal(candidates.find(c => c.seconds < incumbentSeconds), undefined);
});

test('locks protect their exact positions across the entire removal and insertion span', () => {
    for (const protection of ['explicit', 'order_locked', 'locked', 'unresolved']) {
        const stops = Array.from({ length: 14 }, (_, i) => door(i));
        if (protection === 'order_locked' || protection === 'locked') stops[6][protection] = true;
        if (protection === 'unresolved') stops[6].routing_access = { resolution_status: 'unresolved' };
        const options = protection === 'explicit' ? { lockedStopIds: ['6'] } : {};
        const context = directedContext([...stops].reverse());
        const windows = planDrivingAreaWindows(stops, { ...options, minAreaWindowStops: 3 });
        assert.ok(windows.every(w => w.end <= 6 || w.start > 6));
        const candidates = buildDrivingAreaCandidates(stops, context, null, null, options);
        assert.ok(candidates.length > 0);
        assert.ok(candidates.every(c => c.order[6] === stops[6]));
        assert.ok(candidates.every(c => new Set(c.order).size === stops.length));
    }
});

test('area moves retain coherent same-side passes even when a chain has separated street runs', () => {
    const access = position => ({ confidence: 'high', chainKey: 'verified-chain', side: 'right', positionMeters: position });
    const first = [0, 1].map(i => ({ ...door(i, 'Chain street'), routing_access: access(i * 10) }));
    const outside = [door(10, 'Branch'), door(11, 'Branch')];
    const last = [2, 3].map(i => ({ ...door(i, 'Chain street'), routing_access: access(i * 10) }));
    const stops = [...first, ...outside, ...last];
    const context = directedContext([...last, ...outside, ...first]);
    const candidates = buildDrivingAreaCandidates(stops, context);
    assert.equal(mailCarrierPassViolations(stops, context), 0);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
        assert.equal(mailCarrierPassViolations(candidate.order, context), 0);
        assert.deepEqual(ids(candidate.order.filter(p => p.routing_access)), ['0', '1', '2', '3']);
    }
});

test('candidate membership is exact, deterministic, bounded and never expands a single service run', () => {
    const stops = Array.from({ length: 40 }, (_, i) => door(i));
    const context = directedContext([...stops].reverse());
    const first = buildDrivingAreaCandidates(stops, context, null, null, { maxAreaCandidates: 100 });
    const second = buildDrivingAreaCandidates(stops, context, null, null, { maxAreaCandidates: 100 });
    assert.equal(first.length, 32);
    assert.deepEqual(first.map(c => c.fingerprint), second.map(c => c.fingerprint));
    assert.ok(first.every(c => new Set(c.order).size === 40 && c.order.length === 40));
    assert.equal(buildDrivingAreaCandidates(stops, context).length, 24);
    assert.deepEqual(buildDrivingAreaCandidates(stops.map(p => ({ ...p, street_name: 'One continuous visit' })), context), []);
    assert.throws(() => buildDrivingAreaCandidates([...stops.slice(0, 3), stops[0]], context), /membership/);
});
