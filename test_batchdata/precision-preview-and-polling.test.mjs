import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeDualPredicateCounts } from '../base44/functions/previewBatchDataArea/countProbeLogic.js';
import {
  getPrecisionPreviewAvailability,
  precisionGenerationBlockedByPreview
} from '../src/lib/precisionPreviewAvailability.js';
import { createPrecisionPollingGuard } from '../src/lib/precisionPollingGuard.js';

test('a partial zero count is indeterminate instead of an empty Intel/Sale union', () => {
  const summary = summarizeDualPredicateCounts(
    { source: 'intel', ok: false, count: null },
    { source: 'sale', ok: true, count: 0 }
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.complete, false);
  assert.equal(summary.partial, true);
  assert.equal(summary.candidateCount, 0);
  assert.equal(summary.definitiveZero, false);
});

test('zero is definitive only when both predicates succeed', () => {
  const summary = summarizeDualPredicateCounts(
    { source: 'intel', ok: true, count: 0 },
    { source: 'sale', ok: true, count: 0 }
  );
  assert.equal(summary.complete, true);
  assert.equal(summary.definitiveZero, true);
});

test('partial-success short-window preview warns but does not block generation', () => {
  const preview = {
    provider_candidate_count: 0,
    count_probe: {
      ok: true,
      predicate_counts_complete: false,
      predicate_results: {
        intel: { ok: false, count: null },
        sale: { ok: true, count: 0 }
      }
    }
  };
  const availability = getPrecisionPreviewAvailability(preview);
  assert.equal(availability.partial, true);
  assert.equal(availability.definitiveZero, false);
  assert.equal(precisionGenerationBlockedByPreview(preview, { requiresShortWindowPreflight: true }), false);
});

test('complete dual-zero blocks generation while a total short-window failure requires retry', () => {
  const completeZero = {
    provider_candidate_count: 0,
    count_probe: {
      ok: true,
      predicate_counts_complete: true,
      predicate_results: { intel: { ok: true, count: 0 }, sale: { ok: true, count: 0 } }
    }
  };
  const totalFailure = { provider_candidate_count: null, count_probe: { ok: false } };
  assert.equal(precisionGenerationBlockedByPreview(completeZero), true);
  assert.equal(precisionGenerationBlockedByPreview(totalFailure, { requiresShortWindowPreflight: true }), true);
});

test('poll guard is single-flight and completion-once for an exact job', () => {
  const guard = createPrecisionPollingGuard();
  assert.equal(guard.begin('job-1'), true);
  assert.equal(guard.begin('job-1'), false);
  assert.equal(guard.claimCompletion('job-1'), true);
  assert.equal(guard.claimCompletion('job-1'), false);
  guard.end('job-1');
  assert.equal(guard.begin('job-1'), false);
  assert.equal(guard.hasCompleted('job-1'), true);
});

test('a failed route build releases only that exact completion for retry', () => {
  const guard = createPrecisionPollingGuard();
  assert.equal(guard.begin('job-1'), true);
  assert.equal(guard.claimCompletion('job-1'), true);
  assert.equal(guard.claimCompletion('job-1'), false);
  guard.end('job-1');
  guard.releaseCompletion('job-1');
  assert.equal(guard.hasCompleted('job-1'), false);
  assert.equal(guard.begin('job-1'), true);
  assert.equal(guard.claimCompletion('job-1'), true);
  assert.equal(guard.hasCompleted('job-2'), false);
});
