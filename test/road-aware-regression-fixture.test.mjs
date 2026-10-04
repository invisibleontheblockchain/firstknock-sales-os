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
test('frozen driving guard, window connector scoring and vehicle evidence engine are unchanged', () => {
    const frozen = { 'coreDrivingPilot.js': '4a70dc613058cc4085d134d6a97ab89d2cc160f456d5068f96059c981503f3d8',
        'guardedDrivingWindows.js': baseline.sourceHashes['base44/shared/guardedDrivingWindows.js'],
        'vehicleRouting.js': baseline.sourceHashes['base44/shared/vehicleRouting.js'] };
    for (const [file, hash] of Object.entries(frozen)) {
        const source = readFileSync(new URL('../base44/shared/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(createHash('sha256').update(source).digest('hex'), hash, file + ' needs explicit regression review');
    }
});
