import test from 'node:test';
import assert from 'node:assert/strict';
import { planShortDrivingWindows, MAX_SHORT_DRIVING_WINDOWS } from '../base44/shared/shortDrivingWindows.js';
import { haversineDistanceMiles } from '../base44/shared/routeBounds.js';

const stop = (id, position) => ({ id, lat: 35 + position / 1000, lng: -81 });
const branch = () => [0, 0.1, 3, 2.5, 1, 4, 4.5].map((position, i) => stop(`branch-${i}`, position));
const denseQuestions = () => Array.from({ length: 100 }, (_, i) => stop(`dense-${i}`, Math.floor(i / 7) * 0.1 + [0, 3, 1, 2.5, 0.5, 4, 2][i % 7]));
const length = points => points.slice(1).reduce((sum, p, i) => sum + haversineDistanceMiles(points[i], p), 0);

test('a skipped short branch creates a three-door question with its incoming and onward stops fixed', () => {
    const order = branch();
    const window = planShortDrivingWindows(order).find(w => w.start === 2 && w.end === 5);
    assert.ok(window, 'the branch stop must be movable ahead of the two farther stops');
    const baseline = length(order.slice(1, 6));
    const reordered = length([order[1], order[4], order[3], order[2], order[5]]);
    assert.ok(Math.abs(window.screenGainMiles - (baseline - reordered)) < 1e-10);
    assert.ok(Math.abs(window.screenGainRatio - (baseline - reordered) / baseline) < 1e-10);
    assert.equal(window.local, true); assert.equal(window.short, true);
    assert.equal('order' in window, false, 'geometry discovers work and cannot approve or return a driving order');
});

test('screening includes the fixed onward connection rather than rewarding a cheaper interior alone', () => {
    const monotone = Array.from({ length: 12 }, (_, i) => stop(`forward-${i}`, i / 10));
    assert.deepEqual(planShortDrivingWindows(monotone, { minShortGainMiles: 0 }), []);
    const stationary = monotone.map(p => ({ ...p, lat: 35 }));
    assert.deepEqual(planShortDrivingWindows(stationary, { minShortGainMiles: 0 }), []);
});

test('every question is bounded to three or four mutable stops and two actual outer context stops per side', () => {
    const order = denseQuestions();
    const windows = planShortDrivingWindows(order);
    assert.ok(windows.length > 0);
    for (const w of windows) {
        assert.ok([3, 4].includes(w.end - w.start));
        assert.ok(w.start >= 2 && w.end <= order.length - 2);
        assert.ok(w.screenGainMiles > 0 && w.screenGainRatio > 0 && w.screenGainRatio <= 1);
    }
});

for (const protection of ['locked', 'order_locked', 'unresolved', 'lockedStopIds', 'unresolvedStopIds']) {
    test(`${protection} preserves the protected stop and its two neighbors on either side`, () => {
        const order = denseQuestions(), protectedIndex = 40, options = { maxShortWindows: 24 };
        if (protection === 'unresolved') order[protectedIndex].routing_access = { resolution_status: 'unresolved' };
        else if (protection.endsWith('StopIds')) options[protection] = [order[protectedIndex].id];
        else order[protectedIndex][protection] = true;
        const windows = planShortDrivingWindows(order, options);
        assert.ok(windows.length > 0, 'healthy independent short questions remain eligible');
        assert.ok(windows.every(w => w.end <= protectedIndex - 2 || w.start >= protectedIndex + 3));
    });
}

test('questions rank by screened gain and ratio, respect the discovery cap and do not mutate their input', () => {
    const order = denseQuestions(), original = JSON.stringify(order);
    const all = planShortDrivingWindows(order, { maxShortWindows: 1000 });
    assert.equal(all.length, MAX_SHORT_DRIVING_WINDOWS);
    assert.ok(planShortDrivingWindows(order).length <= 16);
    assert.deepEqual(planShortDrivingWindows(order, { maxShortWindows: 2 }), all.slice(0, 2));
    assert.deepEqual(planShortDrivingWindows(order, { maxShortWindows: 0 }), []);
    assert.ok(all.every((w, i) => !i || all[i - 1].priority >= w.priority));
    assert.deepEqual(planShortDrivingWindows(order, { maxShortWindows: 1000 }), all);
    assert.equal(JSON.stringify(order), original);
});

test('invalid coordinates are quarantined and ambiguous membership cannot produce short questions', () => {
    const order = denseQuestions(); order[40].lat = NaN;
    const windows = planShortDrivingWindows(order, { maxShortWindows: 24 });
    assert.ok(windows.length > 0);
    assert.ok(windows.every(w => w.end <= 38 || w.start >= 43));
    const duplicate = branch(); duplicate[3].id = duplicate[2].id;
    assert.deepEqual(planShortDrivingWindows(duplicate), []);
    assert.deepEqual(planShortDrivingWindows(branch().map(p => ({ lat: p.lat, lng: p.lng }))), []);
});

test('short questions cannot bridge a geographic jump or claim a gain below the configured screen', () => {
    const order = branch(); order[3].lng -= 0.1;
    assert.deepEqual(planShortDrivingWindows(order), []);
    assert.deepEqual(planShortDrivingWindows(branch(), { minShortGainMiles: 0.1, shortRadiusMiles: 0.05 }), []);
});
