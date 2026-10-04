import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCoreDrivingRoute } from '../base44/shared/coreDrivingPilot.js';

const stops = ['a', 'b', 'c'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 1000 }));
const candidateOrder = [stops[0], stops[2], stops[1]];
const measure = (driveSeconds, distanceMiles) => ({ driveSeconds, distanceMiles,
    geometry: [{ lat: 35, lng: -81 }, { lat: 35, lng: -80.999 }] });
const run = async (candidate = measure(90, 9), overrides = {}) => evaluateCoreDrivingRoute({ legacyOrder: stops,
    createContext: async () => ({ vehicleAware: true, routeSequence: async order => order === stops ? measure(100, 10) : candidate }),
    propose: () => candidateOrder, ...overrides });

test('driving pilot accepts only a measured improvement in time without adding miles', async () => {
    const improved = await run();
    assert.equal(improved.selection, 'road_aware');
    assert.equal(improved.properties, candidateOrder);
    for (const proposal of [measure(110, 9), measure(90, 11), measure(100, 9), measure(110, 11)]) {
        const guarded = await run(proposal);
        assert.equal(guarded.selection, 'legacy_guard');
        assert.equal(guarded.properties, stops);
        assert.equal(guarded.selected.driveSeconds, 100);
        assert.equal(guarded.selected.distanceMiles, 10);
    }
});
test('bad access and oversized routes keep exact legacy order without provider requests or fabricated metrics', async () => {
    const noRequest = async () => { throw new Error('must not request'); };
    const bad = await run(null, { problemPins: [123], createContext: noRequest });
    assert.equal(bad.selection, 'legacy_fallback');
    assert.equal(bad.reason, 'UNRESOLVED_ACCESS');
    assert.equal(bad.properties, stops);
    assert.equal(bad.selected, null);
    const giant = Array.from({ length: 501 }, (_, i) => ({ ...stops[0], address_hash: String(i) }));
    const big = await run(null, { legacyOrder: giant, createContext: noRequest });
    assert.equal(big.reason, 'ROUTE_TOO_LARGE');
    assert.equal(big.properties, giant);
});
test('an unavailable legacy measurement cannot admit an uncomparable proposal', async () => {
    let proposed = false;
    const result = await run(null, { createContext: async () => ({ vehicleAware: true,
        routeSequence: async () => { throw new Error('NoRoute'); } }), propose: () => { proposed = true; return candidateOrder; } });
    assert.equal(proposed, false);
    assert.equal(result.eligible, false);
    assert.equal(result.properties, stops);
    assert.equal(result.selected, null);
});
test('proposal failure retains measured legacy, but membership errors and cancellation stop the operation', async () => {
    const retained = await run(null, { propose: () => { throw new Error('No complete proposed road path'); } });
    assert.equal(retained.selection, 'legacy_guard');
    assert.equal(retained.selected.driveSeconds, 100);
    await assert.rejects(run(null, { propose: () => [stops[0], stops[1]] }), /membership/);
    await assert.rejects(run(null, { createContext: async () => { throw new DOMException('Cancelled', 'AbortError'); } }), /Cancelled/);
});
