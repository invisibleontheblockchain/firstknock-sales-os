// Coverage for the road-graph topology measurements used in corpus selection.
//
// These numbers decide which real territory represents "single-entry subdivision"
// and "cul-de-sac heavy", so an off-by-one in the articulation search would put the
// wrong geography in the corpus and quietly bias every later benchmark. The graphs
// here are small enough to reason about by hand.

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRoadTopology } from '../scripts/corpus/roadGraph.js';

// Overpass-shaped way: node ids plus geometry. Coordinates are spaced so each
// segment is a known, non-zero length.
const way = (nodes, startLat, startLng, step = 0.001) => ({
    nodes,
    geometry: nodes.map((_, i) => ({ lat: startLat + i * step, lon: startLng }))
});

const geography = { area_sq_mi: 1 };

test('ROAD-01 a dangling tail off a loop is one single-entry pocket', () => {
    // Square loop 1-2-3-4-1, plus a tail 1-5-6 hanging off node 1.
    const network = {
        ways: [
            { nodes: [1, 2, 3, 4, 1], geometry: [
                { lat: 35.0, lon: -80.0 }, { lat: 35.002, lon: -80.0 },
                { lat: 35.002, lon: -80.002 }, { lat: 35.0, lon: -80.002 }, { lat: 35.0, lon: -80.0 }
            ] },
            way([1, 5, 6], 35.0, -80.0)
        ],
        osmDataTimestamp: '2026-08-01T00:00:00Z'
    };

    const topology = describeRoadTopology(network, geography);

    assert.equal(topology.ok, true);
    assert.equal(topology.articulation_point_count, 1, 'node 1 is the only cut vertex');
    assert.equal(topology.bridge_edge_count, 1, 'the tail collapses to one junction-to-junction bridge edge');
    assert.equal(topology.dead_end_count, 1, 'node 6 terminates');
    // Both the loop and the tail hang off node 1, so all street length here really is
    // reached through one point: a loop road attached at a single junction is a
    // single-entry pocket exactly as a cul-de-sac is.
    assert.equal(topology.single_entry_pocket_count, 2, 'the ring and the tail');
    assert.equal(topology.single_entry_pocket_share, 100);
    assert.equal(topology.osm_data_timestamp, '2026-08-01T00:00:00Z');
});

test('ROAD-02 a pure grid has no single-entry pockets and no dead ends', () => {
    // Two squares sharing an edge: fully biconnected, so nothing hangs off one point.
    const network = { ways: [
        { nodes: [1, 2, 5, 4, 1], geometry: [
            { lat: 35.0, lon: -80.0 }, { lat: 35.001, lon: -80.0 },
            { lat: 35.001, lon: -80.001 }, { lat: 35.0, lon: -80.001 }, { lat: 35.0, lon: -80.0 }
        ] },
        { nodes: [2, 3, 6, 5, 2], geometry: [
            { lat: 35.001, lon: -80.0 }, { lat: 35.002, lon: -80.0 },
            { lat: 35.002, lon: -80.001 }, { lat: 35.001, lon: -80.001 }, { lat: 35.001, lon: -80.0 }
        ] }
    ] };

    const topology = describeRoadTopology(network, geography);

    assert.equal(topology.dead_end_count, 0);
    assert.equal(topology.bridge_edge_count, 0);
    assert.equal(topology.single_entry_pocket_share, 0);
});

test('ROAD-03 a collector with cul-de-sac branches reports most length behind cut vertices', () => {
    // Collector 1-2-3-4 with a cul-de-sac hanging off nodes 2 and 3. Every branch and
    // every collector link is a bridge, so essentially all length is single-entry.
    const network = { ways: [
        way([1, 2, 3, 4], 35.0, -80.0),
        way([2, 10, 11], 35.001, -80.001),
        way([3, 20, 21], 35.002, -80.002)
    ] };

    const topology = describeRoadTopology(network, geography);

    assert.equal(topology.dead_end_count, 4, 'both collector ends and both cul-de-sac ends');
    assert.ok(topology.articulation_point_count >= 2, 'nodes 2 and 3 are cut vertices');
    // In a tree every edge is its own block, so every branch is a single-entry
    // pocket — except the collector link BETWEEN the two cut vertices, which is a
    // connector rather than a pocket. Nearly all length is behind one entry.
    assert.ok(topology.single_entry_pocket_share >= 80, `expected mostly single-entry, got ${topology.single_entry_pocket_share}`);
    assert.ok(topology.single_entry_pocket_share < 100, 'the connector between two cut vertices is not a pocket');
    assert.ok(topology.single_entry_pocket_count >= 4);
    assert.ok(topology.road_meters > 0);
});

test('ROAD-04 an empty network is reported as unmeasured, never as barrier-free', () => {
    const topology = describeRoadTopology({ ways: [] }, geography);
    assert.equal(topology.ok, false);
    assert.equal(topology.error, 'NO_ROAD_EDGES');
});