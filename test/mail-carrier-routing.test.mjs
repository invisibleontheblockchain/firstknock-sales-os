import test from 'node:test';
import assert from 'node:assert/strict';
import { inferMailCarrierAccess, planMailCarrierWindows, buildMailCarrierCandidates, hasCoherentMailCarrierPasses } from '../base44/shared/mailCarrierRouting.js';
import { reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';

const stop = (id, position, side = 'right') => ({ id, address_hash: id, street_name: 'Carrier Lane',
    house_number: '102', lat: 35 + (side === 'right' ? -0.0001 : 0.0001), lng: -81 + position / 100000 });
const pins = [stop('r1', 10), stop('l1', 10, 'left'), stop('r2', 30), stop('l2', 30, 'left')];
const evidence = stops => ({ waypoints: stops.map(p => ({ name: p.street_name, location: [p.lng, 35] })),
    steps: [{ name: 'Carrier Lane', driving_side: 'right', geometry: {
        coordinates: [[-81, 35], ...stops.map(p => [p.lng, 35]).sort((a, b) => a[0] - b[0]), [-80.9995, 35]],
    } }] });

test('named road geometry supplies opposite service bearings without inferring side from house-number parity', () => {
    const sides = inferMailCarrierAccess(pins, evidence(pins));
    assert.equal(sides.size, 4);
    assert.equal(sides.get('r1').serviceBearing, 90);
    assert.equal(sides.get('l1').serviceBearing, 270);
    assert.equal(sides.get('r1').side, sides.get('r2').side);
    assert.notEqual(sides.get('r1').side, sides.get('l1').side);
    assert.equal(sides.get('r1').chainKey, sides.get('l2').chainKey);
});

test('wrong road names, centerline pins, missing driving-side evidence and mismatched provider snaps stay uncertain', () => {
    const center = [{ ...pins[0], lat: 35 }];
    assert.equal(inferMailCarrierAccess(center, evidence(center)).size, 0);
    for (const change of [e => e.waypoints.forEach(p => p.name = 'Other Lane'),
        e => delete e.steps[0].driving_side, e => e.steps[0].driving_side = 'left',
        e => e.waypoints.forEach(p => p.location[1] += 0.001)]) {
        const e = evidence(pins); change(e); assert.equal(inferMailCarrierAccess(pins, e).size, 0);
    }
});

test('named provider matches classify roadside service separately from driveway frontage; corners remain uncertain', () => {
    const e = evidence(pins);
    e.steps.push({ name: 'Other Lane', driving_side: 'right', geometry: { coordinates: [[-81, 35.0002], [-80.9995, 35.0002]] } });
    const sides = inferMailCarrierAccess(pins, e);
    assert.equal(sides.has('l1'), true);
    assert.equal(sides.get('l1').frontageVerified, false);
    const corner = evidence(pins);
    corner.steps.push({ name: 'Branch Road', driving_side: 'right', geometry: { coordinates: [[pins[0].lng, 35], [pins[0].lng, 35.001]] } });
    assert.equal(inferMailCarrierAccess(pins, corner).has('r1'), false);
});

const doors = Array.from({ length: 12 }, (_, i) => [stop(`r${i}`, 10 + i * 10), stop(`l${i}`, 10 + i * 10, 'left')]).flat()
    .map(p => ({ ...p, routing_access: { confidence: 'high', chainKey: 'carrier-road',
        positionMeters: Math.round((p.lng + 81) * 100000), side: p.id[0] === 'r' ? 'right' : 'left',
        serviceBearing: p.id[0] === 'r' ? 90 : 270, point: { lat: 35, lng: p.lng } } }));
const phase = p => p.id[0] === 'r' ? p.routing_access.positionMeters : 600 - p.routing_access.positionMeters;
const cost = (a, b) => (phase(b) - phase(a) + 600) % 600;
const mock = { accessFor: p => p.routing_access, optimizationCostBetween: cost,
    distanceBetween: (a, b) => cost(a, b) / 1609.344,
    async routeSequence(order) {
        const meters = order.slice(1).reduce((s, p, i) => s + cost(order[i], p), 0);
        return { driveSeconds: meters / 10, distanceMiles: meters / 1609.344,
            estimatedTurnarounds: order.slice(1).filter((p, i) => p.id[0] !== order[i].id[0]).length,
            directedLegs: order.slice(1).map((p, i) => ({ from: order[i].id, to: p.id,
                pathKey: `${order[i].id}:${p.id}`, driveSeconds: cost(order[i], p) / 10,
                distanceMiles: cost(order[i], p) / 1609.344 })) };
    } };

test('a 24-door street is one service review, rather than alternating sides in ten-door chunks', () => {
    assert.ok(planMailCarrierWindows(doors).some(w => w.start === 0 && w.end === 24));
    const best = buildMailCarrierCandidates(doors, mock,
        { id: 'r-entry', routing_access: { positionMeters: 0 } }, { id: 'l-exit', routing_access: { positionMeters: 0 } })[0].order;
    assert.deepEqual(best.map(p => p.id), [...Array.from({ length: 12 }, (_, i) => `r${i}`),
        ...Array.from({ length: 12 }, (_, i) => `l${11 - i}`)]);
});

test('mail-carrier passes reject repeated side switches and same-side reversals, including boundary stops', () => {
    const right = doors.filter(p => p.id[0] === 'r'), left = doors.filter(p => p.id[0] === 'l');
    assert.equal(hasCoherentMailCarrierPasses([right[0], left[0], right[1]], mock), false);
    assert.equal(hasCoherentMailCarrierPasses([right[0], right[2], right[1]], mock), false);
    assert.equal(hasCoherentMailCarrierPasses([right[0], right[1], left[1], left[0]], mock), true);
    assert.equal(hasCoherentMailCarrierPasses([left[1], left[0], right[0], right[1]], mock), true);
});

test('different service cuts on one physical edge do not fabricate branches', () => {
    const e = evidence(pins);
    e.steps.push({ name: 'Carrier Lane', driving_side: 'right', geometry: { coordinates: [[-81, 35], [-80.9995, 35]] } });
    const accesses = inferMailCarrierAccess(pins, e);
    assert.equal(accesses.size, 4);
    assert.equal(new Set([...accesses.values()].map(a => a.chainKey)).size, 1);
});

test('a named closed street supports cyclic side passes with one wrap per side', () => {
    const ring = [[-81, 35], [-80.998, 35], [-80.998, 35.002], [-81, 35.002], [-81, 35]];
    const points = [{ lat: 34.9999, lng: -80.999 }, { lat: 35.0001, lng: -80.999 },
        { lat: 35.001, lng: -80.9979 }, { lat: 35.001, lng: -80.9981 },
        { lat: 35.0021, lng: -80.999 }, { lat: 35.0019, lng: -80.999 }]
        .map((p, i) => ({ ...p, address_hash: `circle-${i}`, street_name: 'Carrier Circle' }));
    const accesses = inferMailCarrierAccess(points, { waypoints: [[-80.999, 35], [-80.999, 35],
        [-80.998, 35.001], [-80.998, 35.001], [-80.999, 35.002], [-80.999, 35.002]]
        .map(location => ({ location, name: 'Carrier Circle' })),
    steps: [{ name: 'Carrier Circle', driving_side: 'right', geometry: { coordinates: ring } }] });
    assert.equal(accesses.size, 6);
    assert.ok([...accesses.values()].every(a => a.circular));
    const context = { accessFor: p => accesses.get(p.address_hash), optimizationCostBetween: () => 1, distanceBetween: () => 1 };
    const candidates = buildMailCarrierCandidates(points, context);
    assert.ok(candidates.length >= 8);
    assert.ok(candidates.every(c => hasCoherentMailCarrierPasses(c.order, context)));
});

test('the full street pass is measured on the same curb policy before adoption and keeps every door', async () => {
    const result = await reviewLocalDrivingNeighborhoods(doors, { mailCarrierMode: true,
        createLocalDrivingContext: async () => mock, localReviewBudgetMs: 5000 });
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(result.diagnostics.streetSideService.knownStops, 24);
    assert.deepEqual(new Set(result.properties), new Set(doors));
    assert.equal(result.properties.slice(1).filter((p, i) => p.id[0] !== result.properties[i].id[0]).length, 1);
    const locked = doors.map((p, i) => i === 10 ? { ...p, locked: true } : p);
    assert.ok(planMailCarrierWindows(locked).every(w => w.end <= 10 || w.start > 10));
});

test('mail-carrier service wins over a slightly shorter zig-zag, and reports the actual extra travel', async () => {
    const expensivePass = { ...mock, async routeSequence(order) {
        const result = await mock.routeSequence(order);
        const coherent = hasCoherentMailCarrierPasses(order, mock);
        return { ...result, driveSeconds: coherent ? 101 : 100, distanceMiles: coherent ? 1.01 : 1 };
    } };
    const result = await reviewLocalDrivingNeighborhoods(doors, { mailCarrierMode: true,
        createLocalDrivingContext: async () => expensivePass, localReviewBudgetMs: 5000 });
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.ok(result.diagnostics.streetSideService.passViolationsAfter < result.diagnostics.streetSideService.passViolationsBefore);
    assert.ok(result.diagnostics.localMilesSaved < 0);
    assert.equal(result.measurement.distanceMiles, 1.01);
});

test('infeasible inferred one-way headings are removed while original pins and match radii survive', async () => {
    const calls = [];
    const vehicleFetch = async input => {
        const url = new URL(input); calls.push(url);
        const coordinates = url.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
        const bearings = url.searchParams.get('bearings').split(';');
        const failed = bearings.findIndex(b => b.startsWith('270,'));
        if (failed >= 0) return Response.json({ code: 'NoSegment', message: `Could not find a matching segment for coordinate ${failed}` }, { status: 400 });
        const waypoints = coordinates.map(p => ({ location: [p[0], 35], name: 'Carrier Lane' }));
        if (url.pathname.includes('/table/')) {
            const sources = url.searchParams.get('sources').split(';').map(Number), targets = url.searchParams.get('destinations').split(';').map(Number);
            return Response.json({ code: 'Ok', sources: sources.map(i => waypoints[i]), destinations: targets.map(i => waypoints[i]),
                durations: sources.map(a => targets.map(b => a === b ? 0 : 10)), distances: sources.map(a => targets.map(b => a === b ? 0 : 100)) });
        }
        const legs = coordinates.slice(1).map(() => ({ duration: 10, distance: 100, steps: [{ name: 'Carrier Lane',
            driving_side: 'right', geometry: { coordinates: [[-81, 35], [-80.9995, 35]] } }] }));
        return Response.json({ code: 'Ok', waypoints, routes: [{ duration: legs.length * 10,
            distance: legs.length * 100, geometry: { coordinates: waypoints.map(p => p.location) }, legs }] });
    };
    const before = JSON.stringify(pins);
    const result = await reviewLocalDrivingNeighborhoods(pins, { mailCarrierMode: true, vehicleFetch });
    assert.equal(JSON.stringify(pins), before);
    assert.equal(result.diagnostics.streetSideService.knownStops, 2);
    assert.equal(result.diagnostics.streetSideService.unknownStops, 2);
    assert.deepEqual(new Set(result.properties), new Set(pins));
    assert.ok(calls.every(u => u.searchParams.get('radiuses').split(';').every(r => ['40', '100'].includes(r))));
});
