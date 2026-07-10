export const PRECISION_PIPELINE_CONTRACT = 'precision_generate_v2';

export class PrecisionPipelineReleaseMismatchError extends Error {
  constructor(message = 'Precision pipeline components are on different releases.') {
    super(message);
    this.name = 'PrecisionPipelineReleaseMismatchError';
    this.code = 'precision_pipeline_release_mismatch';
  }
}

export function precisionPipelineReady(payload = {}) {
  return payload?.ready === true
    && payload?.precision_pipeline_contract === PRECISION_PIPELINE_CONTRACT;
}

export async function requirePrecisionPipelineReady(invoke) {
  const response = await invoke('precisionPipelineStatus', {});
  const payload = response?.data || {};
  if (!precisionPipelineReady(payload)) {
    throw new PrecisionPipelineReleaseMismatchError();
  }
  return payload;
}

/**
 * Keep the paid start behind the coordinated-release preflight so a failed or
 * missing health response cannot consume BatchData credits.
 */
export async function startPrecisionPullWithPreflight(invoke, payload) {
  await requirePrecisionPipelineReady(invoke);
  return invoke('startBatchDataPull', payload);
}

export function precisionCandidateProperties(response, { exactJob = false } = {}) {
  const payload = response?.data || {};
  if (exactJob && payload.precision_pipeline_contract !== PRECISION_PIPELINE_CONTRACT) {
    throw new PrecisionPipelineReleaseMismatchError(
      'Precision route generation was stopped because the property pipeline is on a different release than the app. Refresh after the backend deployment finishes, then retry this completed pull; no account-wide data was used.'
    );
  }
  return Array.isArray(payload.properties) ? payload.properties : [];
}
