// FREEZE GUARD — Route 1I barrier regression record.
//
// The 1,000-door barrier route cannot be re-solved inside a unit test: solving it
// requires live road routing (~250k road pairs, ~20s). So this suite guards the
// permanent EVIDENCE instead of re-running the solve:
//
//   * the fixture is the real unordered door set, unmodified and un-reordered;
//   * the barrier pair that defines the failure class is still present in it;
//   * the frozen benchmark record still states the accepted reference behavior;
//   * the barrier-repair telemetry contract the record depends on still exists in
//     the shipped module, so the numbers stay interpretable.
//
// Re-measuring the route against these numbers is the benchmark script's job:
//   node scripts/route-barrier-freeze-benchmark.mjs
//
// The algorithm's behavior is pinned separately, without a network, by
// test/barrier-window-repair.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_BARRIER_EXCESS_MILES } from '../base44/shared/barrierWindowRepair.js';
import { DEFAULT_DECOMPOSITION_PORTFOLIO } from '../base44/shared/roadDecompositionPortfolio.js';

const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/charlotte-route-1i-barrier-1000.json', import.meta.url), 'utf8')
);

test('FREEZE-1I-01 fixture is the real 1,000-door set with intact checksum', () => {
    assert.equal(fixture.fixture_version, 'route_1i_barrier_v1');
    assert.equal(fixture.door_count, 1000);
    assert.equal(fixture.doors.length, fixture.door_count);

    const hashes = new Set(fixture.doors.map((door) => door.address_hash));
    assert.equal(hashes.size, fixture.door_count, 'fixture must hold 1,000 distinct doors');

    const checksum = createHash('sha256')
        .update(fixture.doors
            .map((door) => `${door.address_hash}|${door.lat.toFixed(6)}|${door.lng.toFixed(6)}`)
            .join('\n'))
        .digest('hex');
    assert.equal(checksum, fixture.doors_checksum_sha256, 'door coordinates changed since the freeze');
});

test('FREEZE-1I-02 fixture carries no sensitive or solution data', () => {
    // Routing-relevant attributes only. An owner name, price, sale date or a
    // stored stop index would make this a leaked record or a stored answer.
    const allowed = new Set(['address_hash', 'house_number', 'street_name', 'city', 'zip_code', 'lat', 'lng']);
    fixture.doors.forEach((door) => {
        Object.keys(door).forEach((key) => {
            assert.ok(allowed.has(key), `unexpected fixture field: ${key}`);
        });
    });

    // Order-independent evidence: sorted by address_hash, never by visit order.
    const sorted = [...fixture.doors].sort((first, second) => (
        first.address_hash < second.address_hash ? -1 : first.address_hash > second.address_hash ? 1 : 0
    ));
    assert.deepEqual(fixture.doors.map((door) => door.address_hash), sorted.map((door) => door.address_hash));
});

test('FREEZE-1I-03 the barrier pair that defines the failure class is present', () => {
    const { pair, aerial_miles: aerial, road_miles: road, excess_miles: excess } = fixture.barrier_evidence;
    pair.forEach((recorded) => {
        const door = fixture.doors.find((candidate) => candidate.address_hash === recorded.address_hash);
        assert.ok(door, `barrier door missing from fixture: ${recorded.address_hash}`);
        assert.equal(door.lat, recorded.lat);
        assert.equal(door.lng, recorded.lng);
    });

    assert.ok(road > aerial, 'a barrier straddle must drive further than it flies');
    assert.equal(Math.round((road - aerial) * 1000) / 1000, excess);
    // The recorded excess is what makes this route a barrier fixture at all: it
    // must stay far above the detection threshold, or the fixture stops proving
    // the failure class it was frozen for.
    assert.ok(excess > DEFAULT_BARRIER_EXCESS_MILES, 'recorded excess must exceed the detection threshold');
});

test('FREEZE-1I-04 frozen benchmark keeps barrier repair as the accepted reference', () => {
    const { candidates, invariants } = fixture.frozen_benchmark;
    const { geometric_baseline: geometric, coarse_road_grouping: coarse, barrier_repair: repair } = candidates;

    // Repair wins on the only currency that decides acceptance: independently
    // measured road miles.
    assert.ok(repair.verified_road_miles < geometric.verified_road_miles);
    assert.ok(repair.verified_road_miles < coarse.verified_road_miles);
    assert.equal(repair.accepted, true);
    assert.equal(coarse.accepted, false);

    // It wins WITHOUT coarse grouping's tail damage, which is the whole point of
    // repairing rather than replacing the decomposition.
    assert.ok(repair.top_10_longest_miles < coarse.top_10_longest_miles);
    assert.ok(repair.legs_over_5_miles < coarse.legs_over_5_miles);

    // Compactness preserved: same window count as the geometric cut, and the
    // barrier leg is gone.
    assert.equal(repair.windows, geometric.windows);
    assert.ok(repair.longest_leg_miles < geometric.longest_leg_miles / 1.5);

    // Surgical, not global: one window, a handful of blocks.
    assert.equal(repair.barrier_straddling_windows, 1);
    assert.ok(repair.barrier_blocks_moved > 0 && repair.barrier_blocks_moved <= 5);
    assert.ok(repair.barrier_doors_moved > 0 && repair.barrier_doors_moved <= 10);

    // Truth invariants are not negotiable at any mileage.
    assert.equal(invariants.exact_once, true);
    assert.equal(invariants.order_affecting_aerial_decisions, 0);
    assert.equal(invariants.road_aware_leg_pct, 100);
});

test('FREEZE-1I-05 the frozen candidates still exist in the shipped portfolio', () => {
    const ids = new Set(DEFAULT_DECOMPOSITION_PORTFOLIO.map((candidate) => candidate.id));
    ['baseline_windows_92', 'barrier_repaired_windows_92'].forEach((id) => {
        assert.ok(ids.has(id), `frozen candidate removed from the portfolio: ${id}`);
    });

    // The baseline must keep competing, so a future change can never be adopted
    // while measuring worse than the frozen production behavior.
    const baselineIndex = DEFAULT_DECOMPOSITION_PORTFOLIO.findIndex((candidate) => candidate.id === 'baseline_windows_92');
    assert.equal(baselineIndex, 0, 'production baseline must remain the first candidate');
});