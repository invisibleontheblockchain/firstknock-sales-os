// The Route 1H regression, pinned.
//
// 1H shipped 1,000 doors at 627.6 measured road miles while the solver produced
// 394-428 for the same doors. It was never sequenced: generation budgeted 60s for
// the WHOLE batch, optimized the first two routes, and silently skipped the rest.
// Nothing marked the skipped routes, so an unoptimized route was written to the
// database looking exactly like an optimized one.
//
// These tests pin the properties that make that impossible to repeat:
//   - a route with no verdict is never treated as verified (RV-01, RV-02)
//   - only a real road measurement counts as verification (RV-03, RV-12)
//   - the stamp cannot contradict itself (RV-04) or be forged (RV-06)
//   - a batch reports its own gaps instead of returning quietly (RV-07..RV-09)
//   - no reachable outcome leaves a route unmarked (RV-10, RV-13)
//   - the exact 1H batch shape is caught (RV-11)
//
// The verdict logic is pure and lives in src/lib/routeRoadVerification.js so it
// can be executed here rather than asserted against source text — the generation
// loop itself imports through the `@/` build alias and cannot be loaded by the
// node test runner, which is precisely why the decision table was moved out of it.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    ROAD_VERIFICATION,
    describeUnverifiedRoutes,
    isRoadVerified,
    readRoadVerification,
    stampRoadVerification,
    summarizeRoadVerification,
    verdictForOutcome
} from '../src/lib/routeRoadVerification.js';

const routeOf = (id, doors = 10) => ({
    id,
    properties: Array.from({ length: doors }, (_, i) => ({
        address_hash: `${id}-${i}`, lat: 35.4 + i * 0.001, lng: -80.8 + i * 0.001
    }))
});

test('RV-01 an unstamped route is UNKNOWN, never verified', () => {
    const route = routeOf('legacy');
    assert.equal(isRoadVerified(route), false);
    assert.equal(readRoadVerification(route).verdict, ROAD_VERIFICATION.UNKNOWN);
});

test('RV-02 a route claiming road_network_used but carrying no verdict is still not verified', () => {
    // Absence of evidence is not evidence. This shape is exactly what a skipped
    // 1H-era route looked like.
    const route = { ...routeOf('claims'), metadata: { road_network_used: true } };
    assert.equal(isRoadVerified(route), false);
});

test('RV-03 only ADOPTED and CONFIRMED count as verified', () => {
    const verified = [ROAD_VERIFICATION.ADOPTED, ROAD_VERIFICATION.CONFIRMED];
    const unverified = [
        ROAD_VERIFICATION.PASS_FAILED,
        ROAD_VERIFICATION.RUN_CEILING,
        ROAD_VERIFICATION.TOO_FEW_DOORS,
        ROAD_VERIFICATION.LOCAL_FALLBACK,
        ROAD_VERIFICATION.UNKNOWN
    ];
    verified.forEach((verdict) => {
        assert.equal(isRoadVerified(stampRoadVerification(routeOf('r'), verdict)), true, verdict);
    });
    unverified.forEach((verdict) => {
        assert.equal(isRoadVerified(stampRoadVerification(routeOf('r'), verdict)), false, verdict);
    });
});

test('RV-04 the stamp keeps road_network_used in agreement with the verdict', () => {
    // A record that claims both "road aware" and "unverified" is unauditable, and
    // past routes carried exactly that contradiction.
    const stale = { ...routeOf('stale'), metadata: { road_network_used: true } };
    const stamped = stampRoadVerification(stale, ROAD_VERIFICATION.PASS_FAILED, { reason: 'backend_unavailable' });
    assert.equal(stamped.metadata.road_network_used, false);
    assert.equal(stamped.metadata.road_verification.verified, false);
    assert.equal(stamped.metadata.road_verification.reason, 'backend_unavailable');
});

test('RV-05 stamping never mutates the input route', () => {
    const route = routeOf('immutable');
    const before = JSON.stringify(route);
    stampRoadVerification(route, ROAD_VERIFICATION.ADOPTED);
    assert.equal(JSON.stringify(route), before);
});

test('RV-06 an unknown verdict is rejected rather than silently stored', () => {
    assert.throws(() => stampRoadVerification(routeOf('bad'), 'looks_fine_to_me'), /Unknown road verification verdict/);
});

test('RV-07 a batch summary counts every verdict and flags the unverified', () => {
    const batch = [
        stampRoadVerification(routeOf('a'), ROAD_VERIFICATION.ADOPTED),
        stampRoadVerification(routeOf('b'), ROAD_VERIFICATION.CONFIRMED),
        stampRoadVerification(routeOf('c'), ROAD_VERIFICATION.RUN_CEILING),
        stampRoadVerification(routeOf('d'), ROAD_VERIFICATION.PASS_FAILED)
    ];
    const summary = summarizeRoadVerification(batch);
    assert.equal(summary.total, 4);
    assert.equal(summary.verified, 2);
    assert.equal(summary.unverified, 2);
    assert.equal(summary.allVerified, false);
    assert.equal(summary.byVerdict[ROAD_VERIFICATION.RUN_CEILING], 1);
});

test('RV-08 a fully verified batch produces no user-facing warning', () => {
    const batch = [
        stampRoadVerification(routeOf('a'), ROAD_VERIFICATION.ADOPTED),
        stampRoadVerification(routeOf('b'), ROAD_VERIFICATION.CONFIRMED)
    ];
    assert.equal(describeUnverifiedRoutes(batch), null);
    assert.equal(summarizeRoadVerification(batch).allVerified, true);
});

test('RV-09 an unverified batch produces a message naming how many and what to do', () => {
    const batch = [
        stampRoadVerification(routeOf('a'), ROAD_VERIFICATION.ADOPTED),
        stampRoadVerification(routeOf('b'), ROAD_VERIFICATION.RUN_CEILING),
        stampRoadVerification(routeOf('c'), ROAD_VERIFICATION.RUN_CEILING)
    ];
    const message = describeUnverifiedRoutes(batch);
    assert.match(message, /2 of 3 routes/);
    assert.match(message, /straight-line order/);
    assert.match(message, /Optimize/);
});

test('RV-10 every outcome the generation loop can reach produces a verdict, never UNKNOWN', () => {
    // UNKNOWN means "nobody recorded anything", which is the state a skipped 1H
    // route was written in. No reachable outcome may produce it.
    const outcomes = [
        { adopted: true, doorCount: 1000 },
        { doorCount: 0 },
        { doorCount: 1 },
        { doorCount: 1000, ceilingExceeded: true },
        { doorCount: 1000, declineReason: 'current_order_measured_best' },
        { doorCount: 1000, declineReason: 'deadline_exceeded' },
        { doorCount: 1000, declineReason: 'aerial_fallback' },
        { doorCount: 1000, declineReason: 'backend_reported_failure' },
        { doorCount: 1000, declineReason: 'route_exceeds_supported_size' },
        { doorCount: 1000, declineReason: 'backend_unavailable: network down' },
        { doorCount: 1000, declineReason: null }
    ];
    outcomes.forEach((outcome) => {
        const { verdict } = verdictForOutcome(outcome);
        assert.notEqual(verdict, ROAD_VERIFICATION.UNKNOWN, JSON.stringify(outcome));
        assert.ok(Object.values(ROAD_VERIFICATION).includes(verdict));
    });
});

test('RV-11 THE 1H REGRESSION: a batch that exhausts its ceiling marks the skipped routes', () => {
    // Under the old flat 60s whole-run budget, routes 3-8 of an A-H batch were
    // skipped and written with NO marker, so a 628-mile straight-line route was
    // indistinguishable from an optimized one. Simulate that batch shape: the
    // first two routes get their pass, the rest hit the ceiling.
    const batch = Array.from({ length: 8 }, (_, index) => {
        const ceilingExceeded = index >= 2;
        const { verdict, reason } = verdictForOutcome({
            doorCount: 1000,
            ceilingExceeded,
            adopted: !ceilingExceeded
        });
        return stampRoadVerification(routeOf(`1${'ABCDEFGH'[index]}`), verdict, { reason });
    });

    // Route 1H is the eighth. It must not be able to claim verification.
    const routeH = batch[7];
    assert.equal(isRoadVerified(routeH), false);
    assert.equal(readRoadVerification(routeH).verdict, ROAD_VERIFICATION.RUN_CEILING);
    assert.equal(routeH.metadata.road_network_used, false);

    const summary = summarizeRoadVerification(batch);
    assert.equal(summary.verified, 2);
    assert.equal(summary.unverified, 6);
    assert.equal(summary.allVerified, false);
    assert.match(describeUnverifiedRoutes(batch), /6 of 8 routes/);
});

test('RV-12 a road-engine outage is distinguishable from an already-optimal route', () => {
    // Both used to return a bare null and both were recorded as neither, so an
    // outage looked exactly like success. They must now land on different verdicts.
    const outage = verdictForOutcome({ doorCount: 500, declineReason: 'backend_unavailable: ECONNRESET' });
    const optimal = verdictForOutcome({ doorCount: 500, declineReason: 'current_order_measured_best' });

    assert.equal(outage.verdict, ROAD_VERIFICATION.PASS_FAILED);
    assert.equal(optimal.verdict, ROAD_VERIFICATION.CONFIRMED);
    assert.equal(isRoadVerified(stampRoadVerification(routeOf('a'), outage.verdict)), false);
    assert.equal(isRoadVerified(stampRoadVerification(routeOf('b'), optimal.verdict)), true);
});

test('RV-13 adoption outranks every other signal', () => {
    // If an order was actually applied from a measured road matrix, no other
    // circumstance downgrades it.
    const { verdict } = verdictForOutcome({
        doorCount: 1000, adopted: true, ceilingExceeded: true, declineReason: 'deadline_exceeded'
    });
    assert.equal(verdict, ROAD_VERIFICATION.ADOPTED);
});
