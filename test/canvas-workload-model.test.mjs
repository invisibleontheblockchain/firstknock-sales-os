import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_WORKLOAD_DEFAULTS,
  estimateCanvasUnitMinutes,
  formatCanvasFieldHours,
  formatCanvasOpportunityRange,
  formatCanvasStreetMiles,
  getCanvasPlanConfidencePercent,
  getCanvasUnitStreetMeters,
  recommendCanvasAreaCount,
  summarizeCanvasPlanWorkload,
} from '../src/components/canvas/canvasWorkloadModel.js';

// One degree of longitude at the equator is ~111.3 km; keep fixtures small and
// horizontal so the expected distance is easy to reason about.
const unit = (overrides = {}) => ({
  id: overrides.id || 'unit-1',
  canvas_role: 'knock',
  opportunity: { low: 8, expected: 10, high: 12 },
  ...overrides,
});

const horizontalSegment = (meters, lat = 0) => {
  const degrees = meters / 111319.49;
  return [{ start: { lat, lng: 0 }, end: { lat, lng: degrees } }];
};

test('street length falls back to measured geometry and prefers a declared length', () => {
  assert.equal(getCanvasUnitStreetMeters(unit()), 0, 'no geometry means no invented length');

  const measured = getCanvasUnitStreetMeters(unit({ segments: horizontalSegment(300) }));
  assert.ok(Math.abs(measured - 300) < 1, `expected ~300m, got ${measured}`);

  const declared = getCanvasUnitStreetMeters(unit({
    length_meters: 250,
    segments: horizontalSegment(300),
  }));
  assert.equal(declared, 250, 'an adapter-supplied length wins over measured geometry');
});

test('unit minutes combine attempts, walking, and MDU overhead', () => {
  const minutes = estimateCanvasUnitMinutes(unit({
    opportunity: { low: 8, expected: 10, high: 12 },
    segments: horizontalSegment(600),
    mdu_site_count: 2,
  }));

  // 10 doors * 3.5 min = 35, 600m / 60 m-per-min = 10, 2 sites * 12 = 24.
  assert.ok(Math.abs(minutes - 69) < 0.5, `expected ~69 minutes, got ${minutes}`);
});

test('a spread-out unit outweighs a dense unit with the same door count', () => {
  const dense = estimateCanvasUnitMinutes(unit({ segments: horizontalSegment(100) }));
  const spread = estimateCanvasUnitMinutes(unit({ segments: horizontalSegment(2000) }));

  assert.ok(spread > dense, 'walking time must separate equal door counts');
  // This is the whole point of minutes over counts: identical opportunity,
  // materially different day of work.
  assert.ok(spread - dense > 25, `expected a large gap, got ${spread - dense}`);
});

test('non-knock roles carry zero workload, including uncertain', () => {
  for (const role of ['transit_only', 'excluded', 'uncertain']) {
    const minutes = estimateCanvasUnitMinutes(unit({
      canvas_role: role,
      segments: horizontalSegment(900),
    }));
    assert.equal(minutes, 0, `${role} must contribute no workload`);
  }
});

test('length-free evidence degrades to the opportunity term rather than guessing', () => {
  const minutes = estimateCanvasUnitMinutes(unit());
  assert.equal(minutes, 10 * CANVAS_WORKLOAD_DEFAULTS.attempt_minutes);
});

test('plan summary reports miles, hours, uncertain pockets, and geometry presence', () => {
  const analysis = {
    classified_street_units: [
      unit({ id: 'a', segments: horizontalSegment(600) }),
      unit({ id: 'b', segments: horizontalSegment(600) }),
      unit({ id: 'c', canvas_role: 'uncertain', segments: horizontalSegment(500) }),
      unit({ id: 'd', canvas_role: 'excluded', segments: horizontalSegment(5000) }),
    ],
  };

  const summary = summarizeCanvasPlanWorkload(analysis);

  assert.equal(summary.knock_unit_count, 2);
  assert.equal(summary.uncertain_unit_count, 1);
  assert.ok(Math.abs(summary.eligible_street_meters - 1200) < 2, 'only knock units count toward eligible miles');
  assert.ok(summary.has_street_geometry);
  // 2 units * (35 attempt + 10 walk) = 90 minutes over a 50-minute field hour.
  assert.ok(Math.abs(summary.estimated_hours - 1.8) < 0.02, `got ${summary.estimated_hours}`);
});

test('plan summary flags absent geometry instead of implying a walking estimate', () => {
  const summary = summarizeCanvasPlanWorkload({ classified_street_units: [unit()] });
  assert.equal(summary.has_street_geometry, false);
  assert.equal(summary.eligible_street_miles, 0);
});

test('confidence is opportunity-weighted and null when no unit carries it', () => {
  const none = getCanvasPlanConfidencePercent({ classified_street_units: [unit()] });
  assert.equal(none, null, 'never invent a confidence score');

  const weighted = getCanvasPlanConfidencePercent({
    classified_street_units: [
      unit({ id: 'big', confidence: 'high', opportunity: { low: 90, expected: 100, high: 110 } }),
      unit({ id: 'small', confidence: 'low', opportunity: { low: 1, expected: 1, high: 1 } }),
    ],
  });
  // The large high-confidence unit should dominate a single low-confidence door.
  assert.ok(weighted > 95, `expected >95, got ${weighted}`);

  const numeric = getCanvasPlanConfidencePercent({
    classified_street_units: [unit({ confidence: 84 })],
  });
  assert.equal(numeric, 84, 'accepts a 0-100 encoding');
});

test('recommended area count follows hours, falls back to doors, and stays optional', () => {
  const summary = { estimated_hours: 120 };

  const byHours = recommendCanvasAreaCount(summary, { target_hours_per_area: 30 });
  assert.deepEqual(byHours, { count: 4, basis: 'field_hours' });

  const byDoors = recommendCanvasAreaCount({ estimated_hours: 0 }, {
    target_doors_per_area: 500,
    expected_opportunities: 2400,
  });
  assert.deepEqual(byDoors, { count: 5, basis: 'doors' });

  assert.equal(recommendCanvasAreaCount(summary, {}), null, 'no target means no recommendation');
  assert.equal(recommendCanvasAreaCount({ estimated_hours: 1e9 }, {
    target_hours_per_area: 1,
    maximum_areas: 250,
  }).count, 250, 'recommendation is clamped');
});

test('the opportunity range never renders as one confident number', () => {
  assert.equal(formatCanvasOpportunityRange({ low: 5800, expected: 6120, high: 6400 }), '5,800–6,400');
  assert.equal(formatCanvasOpportunityRange({ low: 12, expected: 12, high: 12 }), '12', 'an exact count is not a fake spread');
  assert.equal(formatCanvasOpportunityRange(null), null);
});

test('miles and hours format for scale and stay null when absent', () => {
  assert.equal(formatCanvasStreetMiles(4.25), '4.3 mi');
  assert.equal(formatCanvasStreetMiles(1240), '1,240 mi');
  assert.equal(formatCanvasStreetMiles(0), null);
  assert.equal(formatCanvasFieldHours(3.5), '3.5 hrs');
  assert.equal(formatCanvasFieldHours(214), '214 hrs');
  assert.equal(formatCanvasFieldHours(0), null);
});

// --- locked-area selection (moved out of the page file so it can be executed) ---

const { lockedZonesFromPlan } = await import('../src/components/canvas/canvasPlannerUtils.js');

const planWith = (...zones) => ({ zones });

test('only pinned areas are locked, and their units are copied not shared', () => {
  const plan = planWith(
    { zone_id: 'z1', work_unit_ids: ['a', 'b'] },
    { zone_id: 'z2', work_unit_ids: ['c'] },
  );
  const locked = lockedZonesFromPlan(plan, new Set(['z1']));

  assert.deepEqual(locked, [{ zone_id: 'z1', work_unit_ids: ['a', 'b'] }]);
  locked[0].work_unit_ids.push('mutated');
  assert.deepEqual(plan.zones[0].work_unit_ids, ['a', 'b'], 'the plan must not be mutated through the lock');

  assert.deepEqual(lockedZonesFromPlan(plan, new Set()), []);
  assert.deepEqual(lockedZonesFromPlan(null, new Set(['z1'])), []);
});

test('a just-merged area replaces any pinned area it swallowed', () => {
  const plan = planWith(
    { zone_id: 'z1', work_unit_ids: ['a', 'b'] },
    { zone_id: 'z2', work_unit_ids: ['c', 'd'] },
    { zone_id: 'z3', work_unit_ids: ['e'] },
  );
  // z2 was merged into z1 and both were pinned; z3 is pinned and untouched.
  const merged = { zone_id: 'z1', work_unit_ids: ['a', 'b', 'c', 'd'], locked: true };
  const locked = lockedZonesFromPlan(plan, new Set(['z1', 'z2', 'z3']), merged);

  assert.equal(locked.length, 2, 'the swallowed area must not be locked twice');
  assert.deepEqual(locked[0], merged);
  assert.deepEqual(locked[1].zone_id, 'z3');
  // The partitioner rejects overlapping locks outright, so this de-duplication
  // is what keeps a merge from producing LOCKED_ZONE_OVERLAP.
  const allUnits = locked.flatMap((zone) => zone.work_unit_ids);
  assert.equal(new Set(allUnits).size, allUnits.length, 'no unit may appear in two locks');
});
