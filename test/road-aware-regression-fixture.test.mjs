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
test('neighborhood v5 explicitly versions the driving review while preserving frozen window connector scoring', () => {
    // The original modeled baseline and its source hashes remain historical
    // evidence. V11 verifies an interior shared driving leg with arrival and
    // departure context in both requests and uses its validated step geometry.
    // vehicle-route-chunk-validation.test.mjs covers chunk boundaries, omitted
    // overview points, genuine path/cost disagreement and exact leg coverage.
    // A live 316-stop comparison also passed all three shared-leg checks.
    // Match radii, headings, parking and frozen connector scoring stay fixed.
    // This does not remeasure
    // the private export or change its historical source hashes.
    const frozen = { 'coreDrivingPilot.js': '44ecbfad3d3578258d4d4a19d5ce7f1a43e345f61e5f0f362a71118a5e5d8f90',
        'guardedDrivingWindows.js': baseline.sourceHashes['base44/shared/guardedDrivingWindows.js'],
        'vehicleRouting.js': 'd680c7aa7be23a891f150076f87e90263de810e21f8b1277bbb1a4023ea59be5' };
    for (const [file, hash] of Object.entries(frozen)) {
        const source = readFileSync(new URL('../base44/shared/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(createHash('sha256').update(source).digest('hex'), hash, file + ' needs explicit regression review');
    }
});
