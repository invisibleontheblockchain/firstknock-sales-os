import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/giant-home-regression.json', import.meta.url), 'utf8'));

test('the modeled 6965-stop baseline remains identifiable without publishing the private export', () => {
    assert.equal(baseline.stopCount, 6965); assert.equal(baseline.unresolvedStops, 44);
    assert.equal(baseline.visibleRoutes, 1); assert.equal(baseline.matchLimitMeters, 100);
    assert.equal(baseline.metrics.acceptedRegressions, 0);
    assert.ok(baseline.metrics.distanceReductionPercent > 8.37 && baseline.metrics.distanceReductionPercent < 8.38);
    assert.ok(baseline.metrics.timeReductionPercent > 9.57 && baseline.metrics.timeReductionPercent < 9.58);
    assert.equal(baseline.exportSha256.length, 64); assert.equal(baseline.providerFingerprint.length, 64);
});
test('neighborhood v3 explicitly versions the driving review while preserving frozen window connector scoring', () => {
    // The original modeled baseline and its source hashes remain historical
    // evidence. V3 preserves the vehicle snap and connector policies while
    // exposing provider error codes so a NoSegment can be isolated locally.
    // vehicle-routing.test.mjs, osrm-dispatcher-access.test.mjs, and the local
    // driving regression cover the reviewed change. This does not remeasure
    // the private export or change its historical source hashes.
    const frozen = { 'coreDrivingPilot.js': '44ecbfad3d3578258d4d4a19d5ce7f1a43e345f61e5f0f362a71118a5e5d8f90',
        'guardedDrivingWindows.js': baseline.sourceHashes['base44/shared/guardedDrivingWindows.js'],
        'vehicleRouting.js': 'cd4507a2552427547e6028f2b96c30b87961bf7eb96c5223b4717a38a52568cc' };
    for (const [file, hash] of Object.entries(frozen)) {
        const source = readFileSync(new URL('../base44/shared/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(createHash('sha256').update(source).digest('hex'), hash, file + ' needs explicit regression review');
    }
});
