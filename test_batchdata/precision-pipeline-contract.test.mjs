import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRECISION_PIPELINE_CONTRACT,
  REQUIRED_PRECISION_COMPONENTS,
  summarizePrecisionPipelineComponents
} from '../base44/functions/precisionPipelineStatus/contractLogic.js';
import {
  PrecisionPipelineReleaseMismatchError,
  precisionCandidateProperties,
  requirePrecisionPipelineReady,
  startPrecisionPullWithPreflight
} from '../src/lib/precisionPipelineContract.js';

test('Precision pipeline is ready only when every required component matches', () => {
  const matching = REQUIRED_PRECISION_COMPONENTS.map(component => ({
    component,
    precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT
  }));
  assert.equal(summarizePrecisionPipelineComponents(matching).ready, true);

  const skewed = matching.map(result => result.component === 'fetchJobStatus'
    ? { ...result, precision_pipeline_contract: 'older_release' }
    : result);
  const summary = summarizePrecisionPipelineComponents(skewed);
  assert.equal(summary.ready, false);
  assert.equal(summary.components.find(component => component.component === 'fetchJobStatus').ready, false);
});

test('missing components fail closed before a paid provider request', () => {
  const summary = summarizePrecisionPipelineComponents([
    { component: 'startBatchDataPull', precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT }
  ]);
  assert.equal(summary.ready, false);
  assert.equal(summary.components.filter(component => !component.ready).length, REQUIRED_PRECISION_COMPONENTS.length - 1);
});

test('failed frontend preflight makes zero paid start calls', async () => {
  const calls = [];
  const invoke = async (name) => {
    calls.push(name);
    if (name === 'precisionPipelineStatus') {
      return { data: { ready: false, precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT } };
    }
    throw new Error('paid start must not run');
  };

  await assert.rejects(
    startPrecisionPullWithPreflight(invoke, { polygon: [] }),
    PrecisionPipelineReleaseMismatchError
  );
  assert.deepEqual(calls, ['precisionPipelineStatus']);
});

test('matching frontend preflight invokes the paid start exactly once', async () => {
  const calls = [];
  const invoke = async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'precisionPipelineStatus') {
      return { data: { ready: true, precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT } };
    }
    return { data: { job_id: 'job-1' } };
  };

  await requirePrecisionPipelineReady(invoke);
  calls.length = 0;
  const response = await startPrecisionPullWithPreflight(invoke, { polygon: [{ lat: 1, lng: 2 }] });
  assert.equal(response.data.job_id, 'job-1');
  assert.deepEqual(calls.map(call => call.name), ['precisionPipelineStatus', 'startBatchDataPull']);
});

test('an exact candidate response mismatch fails before properties reach filtering or saving', () => {
  const staleResponse = {
    data: {
      precision_pipeline_contract: 'older_release',
      properties: [{ id: 'must-not-route' }]
    }
  };
  assert.throws(
    () => precisionCandidateProperties(staleResponse, { exactJob: true }),
    PrecisionPipelineReleaseMismatchError
  );
  assert.deepEqual(
    precisionCandidateProperties(staleResponse, { exactJob: false }),
    [{ id: 'must-not-route' }]
  );
});
