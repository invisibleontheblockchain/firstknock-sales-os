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
test('neighborhood v2 explicitly versions the driving review while preserving frozen window connector scoring', () => {
    // The original modeled baseline and its source hashes remain historical
    // evidence. V2 adds the reviewed proposal and sparse final-route evidence;
    // neighborhood-excursions.test.mjs and the existing guard suites exercise
    // that change. This is not a new field benchmark for the private export.
    const frozen = { 'coreDrivingPilot.js': '44ecbfad3d3578258d4d4a19d5ce7f1a43e345f61e5f0f362a71118a5e5d8f90',
        'guardedDrivingWindows.js': baseline.sourceHashes['base44/shared/guardedDrivingWindows.js'],
        'vehicleRouting.js': 'ca8728a4ded09a7ab3e4118edf31cb144029b93385d0c06ce1eb66680a688511' };
    for (const [file, hash] of Object.entries(frozen)) {
        const source = readFileSync(new URL('../base44/shared/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(createHash('sha256').update(source).digest('hex'), hash, file + ' needs explicit regression review');
    }
});
