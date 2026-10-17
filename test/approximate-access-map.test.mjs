import test from 'node:test';
import assert from 'node:assert/strict';
import { approximateAccessStops } from '../src/lib/approximateAccess.js';

test('a route lists its approximate stops from the saved recovery, at either metadata level', () => {
    const recovery = { approximate: [{ property_id: 'ALCOVE RD|28117', stop_number: 170, snap_meters: 150 }],
        access_overrides: { '116 HUNT CAMP TRL|28036': { source: 'approximate_nearest_road', approximate: true, evidence: { snapMeters: 180.4 } },
            '5 MAIN ST|28117': { source: 'address_geocode_recovery' } } };
    for (const route of [{ metadata: { road_access_recovery: recovery } }, { metadata: { routing: { road_access_recovery: recovery } } }]) {
        const stops = approximateAccessStops(route);
        assert.deepEqual([...stops.keys()].sort(), ['116 HUNT CAMP TRL|28036', 'ALCOVE RD|28117']);
        assert.equal(stops.get('ALCOVE RD|28117').snapMeters, 150);
        assert.equal(stops.get('116 HUNT CAMP TRL|28036').snapMeters, 180);
    }
    assert.equal(approximateAccessStops(null).size, 0);
});
