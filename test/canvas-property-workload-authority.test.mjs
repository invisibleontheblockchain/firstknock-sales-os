import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshot } from '../services/canvas-analysis-service/src/analysis-service.mjs';
import { partitionCanvasResidentialTerritories } from '../src/components/logic/canvasResidentialTerritoryAnalysis.js';

const ids = ['a', 'b', 'c', 'd'].map((value) => `cewu1_${value.repeat(64)}`);
const properties = [4, 4, 1, 1].flatMap((count, unitIndex) => Array.from({ length: count }, (_, index) => ({
  property_id: `cepr1_${String(unitIndex * 10 + index).padStart(64, '0')}`,
  fk_property_id: `FKP1_${String(unitIndex * 10 + index).padStart(64, '0')}`,
  property_key: `property-${unitIndex}-${index}`,
  work_unit_id: ids[unitIndex],
  property_type: 'residential',
  canvass_eligibility: 'eligible',
  door_count: 1,
  confidence: { score: 1, reasons: ['residential_address'] },
  building_linkage: [],
  road_linkage: { method: 'fixture' },
  provenance: [{ source_id: 'fixture' }],
  point: { lat: 39 + unitIndex * 0.001, lng: -77 },
})));

test('signed analysis projects eligible properties as exact split workload', () => {
  const work_units = ids.map((id, index) => ({
    work_unit_id: id,
    canvas_role: 'opportunity',
    opportunity: { min: 100, expected: 100, max: 100 },
    neighbor_ids: [ids[index - 1], ids[index + 1]].filter(Boolean),
    geometry: { type: 'LineString', coordinates: [[-77, 39 + index * 0.001], [-76.999, 39 + index * 0.001]] },
  }));
  const release = { release_id: `cer1_${'e'.repeat(64)}`, manifest_hash: 'f'.repeat(64), source_versions: {}, source_attribution: 'Fixture', manifest: { release: { compiler_version: 'fixture/1' } } };
  const snapshot = buildSnapshot({ area_count: 2, polygon: [{ lat: 39, lng: -77 }, { lat: 39, lng: -76.9 }, { lat: 39.1, lng: -76.9 }], manager_id: 'manager', provider: 'fixture', release_id: release.release_id, manifest_hash: release.manifest_hash, tile_ids: [] }, release, { work_units, properties, protected_groups: [], external_neighbor_ids: [] }, '2026-08-17T00:00:00.000Z');
  const analysis = snapshot.analysis_result;
  assert.equal(analysis.summary.workload_authority, 'eligible_properties');
  assert.equal(analysis.summary.opportunity.expected, 10);
  assert.deepEqual(analysis.classified_street_units.map((unit) => unit.opportunity?.expected), [4, 4, 1, 1]);
  const split = partitionCanvasResidentialTerritories({ street_units: analysis.classified_street_units.map((unit) => ({ ...unit, id: unit.work_unit_id })), area_count: 2 });
  assert.equal(split.ok, true);
  const workloads = split.zones.map((zone) => zone.opportunity_expected).sort((a, b) => a - b);
  assert.equal(workloads.reduce((sum, value) => sum + value, 0), 10);
  assert.ok(workloads[1] - workloads[0] <= 2);
});

test('genuine disconnected property islands are allocated deterministically without fake topology', () => {
  const connectedIds = ['main-a', 'main-b', 'main-c', 'main-d', 'main-e'];
  const units = [
    ...connectedIds.map((id, index) => ({
      id,
      canvas_role: 'knock',
      opportunity: { low: 140, expected: 140, high: 140 },
      neighbor_ids: [connectedIds[index - 1], connectedIds[index + 1]].filter(Boolean),
      geometry: { type: 'LineString', coordinates: [[-77, 39 + index * 0.001], [-76.999, 39 + index * 0.001]] },
    })),
    {
      id: 'island',
      canvas_role: 'knock',
      opportunity: { low: 13, expected: 13, high: 13 },
      neighbor_ids: [],
      geometry: { type: 'LineString', coordinates: [[-77.02, 39.02], [-77.019, 39.02]] },
    },
  ];
  const first = partitionCanvasResidentialTerritories({ street_units: units, area_count: 5 });
  const second = partitionCanvasResidentialTerritories({ street_units: units, area_count: 5 });
  assert.equal(first.ok, true);
  assert.deepEqual(first.zones, second.zones);
  assert.equal(first.qa.genuine_island_count, 1);
  assert.equal(first.qa.islands_explicit, true);
  assert.equal(first.qa.exclusive_work_unit_coverage, true);
  assert.equal(first.qa.connected_zones, true);
  assert.equal(first.zones.filter((zone) => zone.island_work_unit_ids?.includes('island')).length, 1);
  assert.deepEqual(first.zones.map((zone) => zone.opportunity_expected).sort((a, b) => a - b), [140, 140, 140, 140, 153]);
});