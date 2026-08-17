import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCanvasPropertyEntity, summarizeCanvasPropertyClassifications } from '../src/components/logic/canvasPropertyClassification.js';

const classify = (features) => classifyCanvasPropertyEntity({ property_id: 'property-1', features });

test('separates property type from canvass eligibility with deterministic reasons', () => {
  const home = classify([{ lat: 35, lon: -82, usps_dpv: 'valid', usps_rdi: 'residential', assessor_class: 'single_family', building: 'house' }]);
  assert.equal(home.property_type, 'residential');
  assert.equal(home.canvass_eligibility, 'eligible');
  assert.ok(home.confidence_score >= 0.9);
  assert.deepEqual(home.point, { lat: 35, lng: -82 });

  const courthouse = classify([{ usps_rdi: 'business', assessor_class: 'government', poi_type: 'civic' }]);
  assert.equal(courthouse.property_type, 'government');
  assert.equal(courthouse.canvass_eligibility, 'excluded');
  assert.equal(courthouse.confidence_score, 0.99);
});

test('routes residential access exceptions and conflicting evidence to review', () => {
  const gated = classify([{ usps_rdi: 'residential', building: 'house', canvass_access: 'gated' }]);
  assert.equal(gated.property_type, 'residential');
  assert.equal(gated.canvass_eligibility, 'review');
  assert.ok(gated.classification_reasons.includes('canvass_access_gated'));

  const conflicting = classify([{ usps_rdi: 'residential', building: 'house', assessor_class: 'commercial' }]);
  assert.equal(conflicting.canvass_eligibility, 'review');
  assert.ok(conflicting.classification_reasons.includes('conflicting_property_use'));
});

test('keeps land-use context out of property counts', () => {
  const context = classify([{ landuse: 'residential' }]);
  assert.equal(context.canvass_eligibility, 'review');
  assert.equal(context.property_type, 'residential');
});

test('reports automatic resolution as a property KPI', () => {
  const summary = summarizeCanvasPropertyClassifications([
    { canvass_eligibility: 'eligible' },
    { canvass_eligibility: 'eligible' },
    { canvass_eligibility: 'excluded' },
    { canvass_eligibility: 'review' },
  ]);
  assert.deepEqual(summary, { eligible: 2, excluded: 1, review: 1, total: 4, automatically_resolved: 3, automatically_resolved_percent: 75 });
});