/**
 * ZONE — generation must partition doors into contiguous zones BEFORE ordering.
 *
 * The old behavior ordered every qualifying door into one global street sequence
 * and cut it by count, so two reps were handed order-neighbors from opposite ends
 * of a territory. These tests pin the replacement: one zone per route, sized to
 * the requested route size, geographically separated, membership-preserving, and
 * identical on repeated runs (the route harnesses compare runs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionPropertiesIntoZones } from '../src/components/logic/routeZonePartition.js';

/** Four tight neighborhoods, ~3 miles apart, 25 doors each. */
function buildTerritory() {
    const centers = [
        { lat: 35.2270, lng: -80.8430 },
        { lat: 35.2270, lng: -80.7830 },
        { lat: 35.2870, lng: -80.8430 },
        { lat: 35.2870, lng: -80.7830 }
    ];
    const doors = [];
    centers.forEach((center, zone) => {
        for (let i = 0; i < 25; i++) {
            doors.push({
                address_hash: `z${zone}-d${i}`,
                house_number: 100 + i * 2,
                street_name: `Street ${zone}-${Math.floor(i / 5)}`,
                lat: center.lat + (i % 5) * 0.0008,
                lng: center.lng + Math.floor(i / 5) * 0.0008
            });
        }
    });
    return doors;
}

const TERRITORY = buildTerritory();

test('ZONE-01 one zone per route, each within the requested route size', () => {
    const zoned = partitionPropertiesIntoZones(TERRITORY, 25);
    const counts = new Map();
    zoned.forEach(door => counts.set(door.cluster, (counts.get(door.cluster) || 0) + 1));

    assert.equal(counts.size, 4, `expected 4 zones for 100 doors at 25 per route, got ${counts.size}`);
    for (const [zone, count] of counts) {
        assert.ok(count <= 25, `zone ${zone} holds ${count} doors, above the 25 route size`);
    }
});

test('ZONE-02 membership is preserved exactly — no door added or dropped', () => {
    const zoned = partitionPropertiesIntoZones(TERRITORY, 25);
    assert.equal(zoned.length, TERRITORY.length);
    assert.deepEqual(
        zoned.map(door => door.address_hash).sort(),
        TERRITORY.map(door => door.address_hash).sort()
    );
});

test('ZONE-03 zones are contiguous: doors never cross neighborhoods', () => {
    const zoned = partitionPropertiesIntoZones(TERRITORY, 25);
    const byZone = new Map();
    zoned.forEach((door) => {
        if (!byZone.has(door.cluster)) byZone.set(door.cluster, []);
        byZone.get(door.cluster).push(door);
    });

    // Each seeded neighborhood spans <0.005 degrees. A zone that mixes two of
    // them would span >0.05 — the exact "reps sharing a slice, not an area" bug.
    for (const [zone, doors] of byZone) {
        const latSpan = Math.max(...doors.map(d => d.lat)) - Math.min(...doors.map(d => d.lat));
        const lngSpan = Math.max(...doors.map(d => d.lng)) - Math.min(...doors.map(d => d.lng));
        assert.ok(latSpan < 0.01 && lngSpan < 0.01, `zone ${zone} spans two neighborhoods (${latSpan}, ${lngSpan})`);
    }
});

test('ZONE-04 partitioning is deterministic and input-order independent', () => {
    const signature = (doors) => partitionPropertiesIntoZones(doors, 25)
        .slice()
        .sort((first, second) => (first.address_hash < second.address_hash ? -1 : 1))
        .map(door => `${door.address_hash}:${door.cluster}`)
        .join('|');

    const baseline = signature(TERRITORY);
    assert.equal(signature(TERRITORY), baseline, 'repeated runs must match');
    assert.equal(signature([...TERRITORY].reverse()), baseline, 'input order must not change zones');
});

test('ZONE-05 a territory that fits one route stays a single zone', () => {
    const single = partitionPropertiesIntoZones(TERRITORY.slice(0, 20), 25);
    assert.deepEqual([...new Set(single.map(door => door.cluster))], [0]);
});