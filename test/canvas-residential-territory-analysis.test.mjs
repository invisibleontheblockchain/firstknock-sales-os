import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCanvasResidentialOpportunity,
  analyzeCanvasResidentialTerritory,
  associateCanvasFeaturesToStreetUnits,
  classifyCanvasStreetUnit,
  partitionCanvasResidentialTerritories,
} from '../src/components/logic/canvasResidentialTerritoryAnalysis.js';

const segment = (startLng, endLng, lat = 35) => ({
  start: { lat, lng: startLng },
  end: { lat, lng: endLng },
  highwayTypes: ['residential'],
});

const unit = (id, startLng, endLng, options = {}) => ({
  id,
  streetNames: [options.name || `${id} Street`],
  segments: [segment(startLng, endLng, options.lat || 35)],
  canvas_role: options.role || 'knock',
  opportunity_classification: options.role === 'transit_only' ? 'none' : 'likely',
  access_classification: 'permitted',
  opportunity: { low: options.weight || 1, expected: options.weight || 1, high: options.weight || 1 },
  protected: Boolean(options.protected),
  ...(options.protectedGroupId ? {
    protected_group_id: options.protectedGroupId,
    protected_group_ids: [options.protectedGroupId],
  } : {}),
});

test('uses one precedence-complete opportunity/access decision table', () => {
  const mixed = classifyCanvasStreetUnit({
    highwayTypes: ['primary'],
    opportunity: { low: 2, expected: 4, high: 6 },
    negative_evidence: true,
    access_evidence: [{ tags: { access: 'private', foot: 'yes', barrier: 'gate' } }],
  });
  const commercial = classifyCanvasStreetUnit({
    highwayTypes: ['residential'],
    negative_evidence: true,
    opportunity: { low: 0, expected: 0, high: 0 },
  });
  const unmapped = classifyCanvasStreetUnit({ highwayTypes: ['residential'] });
  const denied = classifyCanvasStreetUnit({
    highwayTypes: ['residential'],
    opportunity: { low: 1, expected: 1, high: 1 },
    access_evidence: [{ tags: { access: 'yes', foot: 'no' } }],
  });
  const unsignedGate = classifyCanvasStreetUnit({
    highwayTypes: ['residential'],
    opportunity: { low: 1, expected: 1, high: 1 },
    access_evidence: [{ tags: { barrier: 'gate' } }],
  });

  assert.deepEqual(
    [mixed.opportunity_classification, mixed.access_classification, mixed.canvas_role],
    ['likely', 'permitted', 'knock'],
  );
  assert.deepEqual(
    [commercial.opportunity_classification, commercial.access_classification, commercial.canvas_role],
    ['none', 'permitted', 'excluded'],
  );
  assert.deepEqual(
    [unmapped.opportunity_classification, unmapped.access_classification, unmapped.canvas_role],
    ['uncertain', 'permitted', 'uncertain'],
  );
  assert.equal(denied.access_classification, 'restricted');
  assert.equal(denied.canvas_role, 'uncertain');
  assert.equal(unsignedGate.access_classification, 'uncertain');
});

test('uses address evidence first and rejects ambiguous or unbounded nearest-road guesses', () => {
  const streets = [
    unit('north', -82.01, -81.99, { name: 'North Road', lat: 35.0002 }),
    unit('south', -82.01, -81.99, { name: 'South Road', lat: 35 }),
  ];
  const result = associateCanvasFeaturesToStreetUnits({
    street_units: streets,
    max_association_meters: 100,
    association_ambiguity_meters: 15,
    features: [
      { id: 'addressed', lat: 35.00005, lon: -82, tags: { building: 'house', 'addr:street': 'North Rd' } },
      { id: 'ambiguous', lat: 35.0001, lon: -82, tags: { building: 'house' } },
      { id: 'remote', lat: 35.01, lon: -82, tags: { building: 'house' } },
    ],
  });

  assert.deepEqual(
    result.associations.find((item) => item.feature_id === 'addressed'),
    {
      feature_id: 'addressed',
      street_unit_id: 'north',
      basis: 'address_street',
      confidence: 'high',
      distance_meters: result.associations.find((item) => item.feature_id === 'addressed').distance_meters,
    },
  );
  assert.equal(result.associations.find((item) => item.feature_id === 'ambiguous').reason, 'ambiguous_nearest_street');
  assert.equal(result.associations.find((item) => item.feature_id === 'remote').reason, 'outside_association_limit');
});

test('estimates each residential entity independently before summing by street', () => {
  const features = [
    { id: 'apt', building_id: 'apt', tags: { building: 'apartments', 'building:units': '12' } },
    { id: 'house', building_id: 'house', tags: { building: 'house', 'addr:housenumber': '10' } },
    { id: 'house-duplicate-address', building_id: 'house', tags: { building: 'house', 'addr:housenumber': '10' } },
    { id: 'lobby', building_id: 'unknown-apartment', tags: { building: 'apartments', entrance: 'main' } },
    { id: 'service', building_id: 'unknown-apartment', tags: { entrance: 'service' } },
  ];
  const associations = features.map((feature) => ({
    feature_id: feature.id,
    street_unit_id: 'oak',
    basis: 'explicit',
  }));
  const result = aggregateCanvasResidentialOpportunity({ features, associations });
  const oak = result.by_street_unit.oak;
  const lobbyEstimate = result.entity_estimates.find((entity) => entity.entity_id === 'unknown-apartment');

  assert.equal(oak.expected, 21);
  assert.equal(oak.low, 15);
  assert.equal(oak.high, 43);
  assert.equal(lobbyEstimate.source, 'multi_unit_proxy');
  assert.equal(lobbyEstimate.expected, 8);
  assert.notEqual(lobbyEstimate.expected, 1);
  assert.deepEqual(oak.sources, ['deduplicated_addresses', 'explicit_units', 'multi_unit_proxy']);
});

test('partitions preclassified units into deterministic connected zones without changing IDs', () => {
  const streets = [
    unit('a', -82.004, -82.003, { weight: 5 }),
    unit('b', -82.003, -82.002, { weight: 5, protected: true }),
    unit('c', -82.002, -82.001, { weight: 5 }),
    unit('d', -82.001, -82, { weight: 5 }),
  ];
  const first = partitionCanvasResidentialTerritories({ street_units: streets, requested_zone_count: 2 });
  const reordered = partitionCanvasResidentialTerritories({ street_units: [...streets].reverse(), area_count: 2 });

  assert.equal(first.ok, true);
  assert.equal(first.zones.length, 2);
  assert.equal(first.qa.connected_zones, true);
  assert.equal(first.qa.protected_units_intact, true);
  assert.equal(first.qa.exclusive_work_unit_coverage, true);
  assert.deepEqual(first.work_units.map((workUnit) => workUnit.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(reordered.zones, first.zones);
  assert.equal(first.zones.flatMap((zone) => zone.work_unit_ids).filter((id) => id === 'b').length, 1);
});

test('minutes workload basis is opt-in and preserves every ownership guarantee', () => {
  // Four equal-door units. The last two are ~20x longer, so they carry the same
  // door count but a materially longer walk.
  const streets = [
    unit('a', -82.00000, -81.99995, { weight: 10 }),
    unit('b', -81.99995, -81.99990, { weight: 10 }),
    unit('c', -81.99990, -81.99890, { weight: 10 }),
    unit('d', -81.99890, -81.99790, { weight: 10 }),
  ];

  const byCount = partitionCanvasResidentialTerritories({ street_units: streets, area_count: 2 });
  const byMinutes = partitionCanvasResidentialTerritories({
    street_units: streets,
    area_count: 2,
    workload_basis: 'minutes',
  });

  assert.equal(byCount.ok, true);
  assert.equal(byMinutes.ok, true);

  for (const result of [byCount, byMinutes]) {
    assert.equal(result.zones.length, 2);
    assert.equal(result.qa.connected_zones, true);
    assert.equal(result.qa.exclusive_work_unit_coverage, true);
    assert.equal(result.qa.protected_units_intact, true);
    assert.deepEqual(
      result.zones.flatMap((zone) => zone.work_unit_ids).sort(),
      ['a', 'b', 'c', 'd'],
    );
  }
});

test('minutes workload stays deterministic under input reordering', () => {
  const streets = [
    unit('a', -82.004, -82.003, { weight: 5 }),
    unit('b', -82.003, -82.002, { weight: 9 }),
    unit('c', -82.002, -82.001, { weight: 2 }),
    unit('d', -82.001, -82, { weight: 7 }),
  ];
  const options = { area_count: 2, workload_basis: 'minutes' };

  const first = partitionCanvasResidentialTerritories({ street_units: streets, ...options });
  const reordered = partitionCanvasResidentialTerritories({ street_units: [...streets].reverse(), ...options });

  assert.equal(first.ok, true);
  assert.deepEqual(reordered.zones, first.zones);
});

test('uses shared permitted transit units for connectivity but never owns them', () => {
  const streets = [
    unit('knock-a', -82.003, -82.002, { weight: 4 }),
    unit('transit', -82.002, -82.001, { role: 'transit_only' }),
    unit('knock-b', -82.001, -82, { weight: 6 }),
  ];
  const result = partitionCanvasResidentialTerritories({ street_units: streets, area_count: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.zones[0].work_unit_ids, ['knock-a', 'knock-b']);
  assert.deepEqual(result.work_units.map((workUnit) => workUnit.id), ['knock-a', 'knock-b']);
  assert.deepEqual(result.shared_transit_unit_ids, ['transit']);
});

test('contracts every edge in a protected cul-de-sac group into one indivisible ownership atom', () => {
  const streets = [
    unit('approach', -82.004, -82.003, { weight: 4 }),
    unit('court-left', -82.003, -82.002, { weight: 2, protected: true, protectedGroupId: 'terminal:900' }),
    unit('court-right', -82.002, -82.001, { weight: 3, protected: true, protectedGroupId: 'terminal:900' }),
  ];
  const result = partitionCanvasResidentialTerritories({ street_units: streets, area_count: 2 });
  const reversed = partitionCanvasResidentialTerritories({ street_units: [...streets].reverse(), area_count: 2 });
  const zoneByUnit = new Map(result.zones.flatMap((zone) => zone.work_unit_ids.map((id) => [id, zone.zone_id])));

  assert.equal(result.ok, true);
  assert.equal(result.qa.protected_units_intact, true);
  assert.equal(zoneByUnit.get('court-left'), zoneByUnit.get('court-right'));
  assert.deepEqual(reversed.zones, result.zones);
  assert.equal(partitionCanvasResidentialTerritories({ street_units: streets, area_count: 3 }).code, 'TOO_MANY_ZONES_FOR_WORK_UNITS');
});

test('runs the vertical analysis slice and preserves drawable topology on classified units', () => {
  const polygon = [
    { lat: 34.999, lng: -82.011 },
    { lat: 34.999, lng: -81.989 },
    { lat: 35.002, lng: -81.989 },
    { lat: 35.002, lng: -82.011 },
  ];
  const roadNetwork = {
    elements: [
      { type: 'node', id: 1, lat: 35, lon: -82.01 },
      { type: 'node', id: 2, lat: 35, lon: -81.99 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential', name: 'Oak Street' } },
      {
        type: 'node',
        id: 10,
        lat: 35.0001,
        lon: -82,
        tags: { building: 'house', 'addr:housenumber': '20', 'addr:street': 'Oak St' },
      },
    ],
  };
  const result = analyzeCanvasResidentialTerritory({ polygon, roadNetwork, area_count: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.deployable, true);
  assert.equal(result.classified_street_units.length, 1);
  assert.equal(result.classified_street_units[0].canvas_role, 'knock');
  assert.equal(result.classified_street_units[0].opportunity.expected, 1);
  assert.ok(result.classified_street_units[0].segments.length > 0);
  assert.deepEqual(result.classified_street_units[0].street_names, ['Oak Street']);
  assert.equal(result.work_units[0].id, result.classified_street_units[0].id);
  assert.equal(result.zones.length, 1);
});
