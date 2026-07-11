import test from 'node:test';
import assert from 'node:assert/strict';

import { getRequestedPrecisionCount } from '../src/lib/precisionRouteCounts.js';

test('uses the capped diagnostic request instead of the pre-cap intent', () => {
  assert.equal(getRequestedPrecisionCount({
    total_expected: 50,
    requested_properties: 1000,
    diagnostics: {
      requested_properties: 50,
      requested_properties_before_cap: 1000,
      limited_by_free_home_cap: true
    }
  }), 50);
});

test('prefers total_expected when a legacy completion payload overwrote requested_properties', () => {
  assert.equal(getRequestedPrecisionCount({
    total_expected: 50,
    requested_properties: 1000,
    diagnostics: {}
  }), 50);
});

test('uses before-cap intent only as a legacy last resort', () => {
  assert.equal(getRequestedPrecisionCount({
    diagnostics: { requested_properties_before_cap: '24' }
  }), 24);
});

test('returns null when no positive request count exists', () => {
  assert.equal(getRequestedPrecisionCount({
    total_expected: 0,
    requested_properties: 'not-a-number',
    diagnostics: { requested_properties_before_cap: null }
  }), null);
});
