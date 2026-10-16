import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferMailCarrierAccess, mailCarrierPassViolations } from '../base44/shared/mailCarrierRouting.js';
import { reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/red-cedar-unnamed-road.json', import.meta.url)));
const copy = value => structuredClone(value);
const line = [[-81, 35], [-80.998, 35]];
const doors = [0, 1, 2, 3].map(i => ({ address_hash: `door-${i}`, house_number: 102,
    street_name: 'Example Lane', lat: 35 + (i % 2 ? 0.0001 : -0.0001), lng: -80.9998 + i * 0.0003 }));
const evidence = points => ({ waypoints: points.map(p => ({ name: '', location: [p.lng, 35] })),
    steps: [{ name: '', driving_side: 'right', geometry: { coordinates: line } }] });

test('an unnamed observed chain establishes side from three distinct provider matches without address parity', () => {
    const accesses = inferMailCarrierAccess(doors, evidence(doors));
    assert.equal(accesses.size, 4);
    assert.equal(new Set([...accesses.values()].map(a => a.chainKey)).size, 1);
    assert.equal(accesses.get('door-0').side, accesses.get('door-2').side);
    assert.notEqual(accesses.get('door-0').side, accesses.get('door-1').side);
    for (const access of accesses.values()) {
        assert.equal(access.source, 'osrm-unnamed-road-side');
        assert.equal(access.roadName, '');
        assert.equal(access.frontageVerified, false);
    }
});

test('unnamed chains need consistent address streets and three distinct matched locations', () => {
    assert.equal(inferMailCarrierAccess(doors.slice(0, 2), evidence(doors.slice(0, 2))).size, 0);
    const conflict = copy(doors); conflict[3].street_name = 'Different Lane';
    assert.equal(inferMailCarrierAccess(conflict, evidence(conflict)).size, 0);
    const coincident = doors.map(p => ({ ...p, lng: doors[0].lng }));
    assert.equal(inferMailCarrierAccess(coincident, evidence(coincident)).size, 0);
});

test('missing driving-side or geometric evidence, centerline pins and unmatched snaps remain unknown', () => {
    for (const change of [e => delete e.steps[0].driving_side, e => e.steps[0].driving_side = 'left',
        e => delete e.steps[0].name, e => e.waypoints.forEach(w => delete w.name),
        e => e.steps = [], e => e.waypoints.forEach(w => w.location[1] += 0.0001)]) {
        const e = evidence(doors); change(e);
        assert.equal(inferMailCarrierAccess(doors, e).size, 0);
    }
    const centerline = doors.map(p => ({ ...p, lat: 35 }));
    assert.equal(inferMailCarrierAccess(centerline, evidence(centerline)).size, 0);
});

test('disconnected anonymous roads and nearby parallel roads cannot be merged into one corroborated chain', () => {
    const split = evidence(doors);
    split.steps = [
        { name: '', driving_side: 'right', geometry: { coordinates: [[-81, 35], [-80.9994, 35]] } },
        { name: '', driving_side: 'right', geometry: { coordinates: [[-80.9993, 35], [-80.998, 35]] } },
    ];
    assert.equal(inferMailCarrierAccess(doors, split).size, 0);
    const parallel = evidence(doors);
    parallel.steps.push({ name: '', driving_side: 'right', geometry: {
        coordinates: line.map(([lng, lat]) => [lng, lat + 0.00005]) } });
    assert.equal(inferMailCarrierAccess(doors, parallel).size, 0);
});

test('a named mismatch cannot be relabelled as an unnamed provider match', () => {
    const e = evidence(doors); e.waypoints.forEach(w => w.name = 'Other Road');
    assert.equal(inferMailCarrierAccess(doors, e).size, 0);
});

test('an intersection and locked or unresolved stops do not acquire curb constraints', () => {
    const e = evidence(doors);
    e.steps.push({ name: 'Cross Street', driving_side: 'right', geometry: {
        coordinates: [[doors[0].lng, 34.9998], [doors[0].lng, 35.0002]] } });
    assert.equal(inferMailCarrierAccess(doors, e).has('door-0'), false);
    for (const marker of [{ locked: true }, { order_locked: true }, { routing_access: { resolution_status: 'unresolved' } }]) {
        const marked = doors.map((p, i) => i ? p : { ...p, ...marker });
        const accesses = inferMailCarrierAccess(marked, evidence(marked));
        assert.equal(accesses.has('door-0'), false);
        assert.equal(accesses.size, 3);
    }
});

test('the reported Red Cedar geometry classifies the interior doors and keeps ambiguous corners unknown', () => {
    const accesses = inferMailCarrierAccess(fixture.stops, fixture.evidence);
    assert.equal(accesses.size, 10);
    const cedar = fixture.stops.filter(p => p.street_name === 'Red Cedar Ln' && accesses.has(p.address_hash));
    assert.equal(cedar.length, 7);
    assert.equal(new Set(cedar.map(p => accesses.get(p.address_hash).chainKey)).size, 1);
    assert.equal(accesses.get('108 Red Cedar Ln').side, accesses.get('132 Red Cedar Ln').side);
    assert.notEqual(accesses.get('108 Red Cedar Ln').side, accesses.get('103 Red Cedar Ln').side);
    for (const id of ['102 Red Cedar Ln', '142 Red Cedar Ln', '128 Sanders Way', '104 Peppervine Ln']) {
        assert.equal(accesses.has(id), false, id);
    }
});

test('reversing the observed traversal preserves the physical chain, side and position', () => {
    const forward = inferMailCarrierAccess(fixture.stops, fixture.evidence);
    const reversed = copy(fixture.evidence);
    reversed.steps.reverse().forEach(step => step.geometry.coordinates.reverse());
    const backward = inferMailCarrierAccess(fixture.stops, reversed);
    assert.equal(backward.size, forward.size);
    for (const [key, value] of forward) {
        assert.equal(backward.get(key).chainKey, value.chainKey, key);
        assert.equal(backward.get(key).side, value.side, key);
        assert.equal(backward.get(key).positionMeters, value.positionMeters, key);
    }
});

test('the real unnamed geometry drives a complete same-side review while preserving every original door', async () => {
    const accesses = inferMailCarrierAccess(fixture.stops, fixture.evidence);
    const accessFor = p => accesses.get(p.address_hash);
    // Equal legal costs make the service objective decisive. The production
    // provider must still validate both complete routes before adoption.
    const measuredOrders = [];
    const context = { accessFor, distanceBetween: () => 0.01, optimizationCostBetween: () => 1,
        async routeSequence(order) {
            measuredOrders.push(order.map(p => p.address_hash));
            return { distanceMiles: (order.length - 1) * 0.01, driveSeconds: order.length - 1,
                directedLegs: order.slice(1).map((p, i) => ({ from: order[i].address_hash, to: p.address_hash,
                    pathKey: `${order[i].address_hash}:${p.address_hash}`, distanceMiles: 0.01, driveSeconds: 1 })) };
        } };
    const result = await reviewLocalDrivingNeighborhoods(fixture.stops, { mailCarrierMode: true,
        knownDrivingAccessFor: accessFor, inferStreetSides: false,
        createLocalDrivingContext: async () => context, localReviewBudgetMs: 5000 });
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(mailCarrierPassViolations(result.properties, context), 0);
    assert.equal(result.diagnostics.streetSideService.passViolationsBefore, 9);
    assert.deepEqual(new Set(result.properties), new Set(fixture.stops));
    assert.ok(measuredOrders.some(order => JSON.stringify(order) === JSON.stringify(fixture.stops.map(p => p.address_hash))));
    assert.ok(measuredOrders.some(order => JSON.stringify(order) === JSON.stringify(result.properties.map(p => p.address_hash))));
});
