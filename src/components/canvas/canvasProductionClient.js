import { base44 } from '@/api/base44Client';

const CANVAS_ANALYSIS_JOB_STORAGE_PREFIX = 'fk_canvasAnalysisJob_v1';

export const MAX_CANVAS_CLASSIFICATION_GROUP_UNITS = 250;

export class CanvasProductionError extends Error {
  constructor(message, { code = 'CANVAS_SERVICE_UNAVAILABLE', status = null, details = null } = {}) {
    super(message);
    this.name = 'CanvasProductionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function responseBody(response) {
  return response?.data ?? response ?? {};
}

function errorMessage(error, fallback) {
  return error?.response?.data?.message
    || error?.response?.data?.error
    || error?.message
    || fallback;
}

async function invokeProductionFunction(functionName, payload, fallbackMessage) {
  try {
    const response = await base44.functions.invoke(functionName, payload);
    const data = responseBody(response);
    if (data?.error || data?.success === false) {
      throw new CanvasProductionError(data.message || data.error || fallbackMessage, {
        code: data.code || data.error || 'CANVAS_REQUEST_REJECTED',
        status: response?.status || null,
        details: data,
      });
    }
    if (data?.success !== true) {
      throw new CanvasProductionError(`${fallbackMessage} The server returned an invalid response.`, {
        code: 'CANVAS_INVALID_RESPONSE',
        status: response?.status || null,
        details: data,
      });
    }
    return data;
  } catch (error) {
    if (error instanceof CanvasProductionError) throw error;
    throw new CanvasProductionError(errorMessage(error, fallbackMessage), {
      code: error?.response?.data?.code || error?.response?.data?.error || 'CANVAS_SERVICE_UNAVAILABLE',
      status: error?.response?.status || null,
      details: error?.response?.data || null,
    });
  }
}

export function saveCanvasDraft(payload) {
  return invokeProductionFunction('canvasSaveDraft', payload, 'Canvas Draft Preview could not be saved. Nothing was deployed.');
}

function analysisStorageKey(managerId) {
  const id = String(managerId || '').trim();
  return id ? `${CANVAS_ANALYSIS_JOB_STORAGE_PREFIX}:${id}` : null;
}

function normalizedStoredPolygon(value) {
  if (!Array.isArray(value)) return [];
  return value.map((point) => {
    const lat = Number(point?.lat ?? point?.latitude);
    const lng = Number(point?.lng ?? point?.lon ?? point?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }).filter(Boolean);
}

export function readPersistedCanvasAnalysisJob(managerId) {
  const key = analysisStorageKey(managerId);
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    const polygon = normalizedStoredPolygon(parsed?.polygon);
    const jobId = String(parsed?.jobId || '').trim();
    if (String(parsed?.managerId || '') !== String(managerId)
      || !/^canvas_analysis_job_[a-f0-9]{64}$/.test(jobId)
      || polygon.length < 3) return null;
    return {
      managerId: String(managerId),
      jobId,
      polygon,
      areaCount: Math.max(1, Math.min(250, Number(parsed?.areaCount) || 1)),
      updatedAt: String(parsed?.updatedAt || ''),
    };
  } catch {
    return null;
  }
}

export function persistCanvasAnalysisJob({ managerId, jobId, polygon, areaCount } = {}) {
  const key = analysisStorageKey(managerId);
  const points = normalizedStoredPolygon(polygon);
  if (!key || typeof localStorage === 'undefined'
    || !/^canvas_analysis_job_[a-f0-9]{64}$/.test(String(jobId || ''))
    || points.length < 3) return false;
  try {
    localStorage.setItem(key, JSON.stringify({
      managerId: String(managerId),
      jobId: String(jobId),
      polygon: points,
      areaCount: Math.max(1, Math.min(250, Number(areaCount) || 1)),
      updatedAt: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearPersistedCanvasAnalysisJob(managerId, expectedJobId = null) {
  const key = analysisStorageKey(managerId);
  if (!key || typeof localStorage === 'undefined') return false;
  try {
    if (expectedJobId) {
      const current = readPersistedCanvasAnalysisJob(managerId);
      if (current && current.jobId !== String(expectedJobId)) return false;
    }
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function startCanvasAnalysis({ polygon, areaCount, retryFailedJob = false } = {}) {
  return invokeProductionFunction('canvasStartAnalysis', {
    polygon,
    area_count: Math.max(1, Number(areaCount) || 1),
    ...(retryFailedJob ? { retry_failed_job: true } : {}),
  }, 'Server residential analysis is unavailable. Canvas can continue with a local preview in development.');
}

export function getCanvasAnalysisStatus({ jobId } = {}) {
  if (!jobId) {
    throw new CanvasProductionError('A Canvas analysis job is required before progress can be loaded.', {
      code: 'CANVAS_ANALYSIS_JOB_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasGetAnalysisStatus', {
    job_id: jobId,
  }, 'Canvas residential analysis progress could not be loaded.');
}

export function cancelCanvasAnalysis({ jobId } = {}) {
  if (!jobId) {
    throw new CanvasProductionError('A Canvas analysis job is required before it can be cancelled.', {
      code: 'CANVAS_ANALYSIS_JOB_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasCancelAnalysis', {
    job_id: jobId,
  }, 'Canvas residential analysis could not be cancelled.');
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new CanvasProductionError('Canvas analysis polling was cancelled.', { code: 'CANVAS_ANALYSIS_CANCELLED' }));
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(new CanvasProductionError('Canvas analysis polling was cancelled.', { code: 'CANVAS_ANALYSIS_CANCELLED' }));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

export async function waitForCanvasAnalysis({
  jobId,
  initialStatus = null,
  onProgress,
  signal,
  pollIntervalMs = 1_500,
  maxWaitMs = 30 * 60 * 1_000,
} = {}) {
  if (!jobId) {
    throw new CanvasProductionError('A Canvas analysis job is required before progress can be loaded.', {
      code: 'CANVAS_ANALYSIS_JOB_REQUIRED',
    });
  }
  const startedAt = Date.now();
  let status = initialStatus?.job_id === jobId ? initialStatus : null;
  while (true) {
    if (!status) status = await getCanvasAnalysisStatus({ jobId });
    if (typeof onProgress === 'function') onProgress(status);
    if (status.status === 'complete') return status;
    if (status.status === 'failed') {
      throw new CanvasProductionError(status.message || 'Large Canvas residential analysis failed.', {
        code: status.error || 'CANVAS_LARGE_ANALYSIS_FAILED',
        details: status,
      });
    }
    if (status.status === 'cancelled') {
      throw new CanvasProductionError(status.message || 'Large Canvas residential analysis was cancelled.', {
        code: 'CANVAS_ANALYSIS_CANCELLED',
        details: status,
      });
    }
    if (!['queued', 'running', 'finalizing'].includes(status.status)) {
      throw new CanvasProductionError('Canvas returned an unknown analysis state.', {
        code: 'CANVAS_ANALYSIS_INVALID_STATUS',
        details: status,
      });
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new CanvasProductionError('Canvas analysis is still running. You can safely return to this plan and continue polling.', {
        code: 'CANVAS_ANALYSIS_WAIT_TIMEOUT',
        details: status,
      });
    }
    const serverDelay = Number(status.poll_after_ms);
    const delay = Math.max(750, Math.min(10_000, Number.isFinite(serverDelay) ? serverDelay : Number(pollIntervalMs) || 1_500));
    await abortableDelay(delay, signal);
    status = null;
  }
}

export async function analyzeCanvasBoundary(options = {}) {
  const started = options.resumeJobId
    ? await getCanvasAnalysisStatus({ jobId: options.resumeJobId })
    : await startCanvasAnalysis(options);
  if (started.status === 'complete') return started;
  if (started.status === 'cancelled') {
    throw new CanvasProductionError('Large Canvas residential analysis was cancelled. Retry to start it again.', {
      code: 'CANVAS_ANALYSIS_CANCELLED',
      details: started,
    });
  }
  if (!started.job_id) {
    throw new CanvasProductionError('Canvas did not return a resumable analysis job.', {
      code: 'CANVAS_ANALYSIS_JOB_MISSING',
      details: started,
    });
  }
  return waitForCanvasAnalysis({
    jobId: started.job_id,
    initialStatus: started,
    onProgress: options.onProgress,
    signal: options.signal,
    pollIntervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
  });
}

export function getCanvasAnalysis({ evidenceId, revisionId, useRevisionHead = true } = {}) {
  if (!evidenceId) {
    throw new CanvasProductionError('Residential evidence is required before analysis can be loaded.', {
      code: 'CANVAS_EVIDENCE_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasGetAnalysis', {
    evidence_id: evidenceId,
    ...(revisionId ? { revision_id: revisionId } : {}),
    use_revision_head: useRevisionHead === true,
  }, 'Canvas residential evidence could not be loaded.');
}

export function applyCanvasClassificationOverride({
  evidenceId,
  parentRevisionId,
  streetUnitId,
  streetUnitIds,
  canvasRole,
  opportunityClassification,
  accessClassification,
  opportunityCount,
  reason,
} = {}) {
  const targetUnitIds = [...new Set((Array.isArray(streetUnitIds) && streetUnitIds.length
    ? streetUnitIds
    : [streetUnitId]).map((value) => String(value || '').trim()).filter(Boolean))].sort();
  if (!evidenceId || !targetUnitIds.length || !String(reason || '').trim()) {
    throw new CanvasProductionError('Choose an amber street and enter a reason before applying an override.', {
      code: 'CANVAS_OVERRIDE_INPUT_REQUIRED',
    });
  }
  if (targetUnitIds.length > MAX_CANVAS_CLASSIFICATION_GROUP_UNITS) {
    throw new CanvasProductionError(`An audited group may contain at most ${MAX_CANVAS_CLASSIFICATION_GROUP_UNITS} street units.`, {
      code: 'CANVAS_OVERRIDE_GROUP_TOO_LARGE',
    });
  }
  if (targetUnitIds.length > 1 && !['transit_only', 'excluded'].includes(canvasRole)) {
    throw new CanvasProductionError('Only Transit or Exclude decisions may be saved as an audited group.', {
      code: 'CANVAS_OVERRIDE_GROUP_ROLE_INVALID',
    });
  }
  return invokeProductionFunction('canvasApplyClassificationOverride', {
    evidence_id: evidenceId,
    ...(parentRevisionId ? { parent_revision_id: parentRevisionId } : {}),
    street_unit_id: targetUnitIds[0],
    ...(targetUnitIds.length > 1 ? { street_unit_ids: targetUnitIds } : {}),
    override_canvas_role: canvasRole,
    ...(opportunityClassification ? { override_opportunity_classification: opportunityClassification } : {}),
    ...(accessClassification ? { override_access_classification: accessClassification } : {}),
    ...(Number.isFinite(Number(opportunityCount)) ? { opportunity_count: Number(opportunityCount) } : {}),
    override_reason: String(reason).trim(),
  }, 'The amber classification could not be revised. Activation remains blocked.');
}

export function deployCanvasCampaign({ sessionId, expectedVersion, idempotencyKey, supersedeSessionIds = [] }) {
  return invokeProductionFunction('canvasDeployCampaign', {
    session_id: sessionId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    ...(supersedeSessionIds.length ? { supersede_session_ids: supersedeSessionIds } : {}),
  }, 'Canvas campaign could not be deployed. Nothing was sent to reps.');
}

export function closeCanvasCampaign({ sessionId, expectedVersion, idempotencyKey, action }) {
  return invokeProductionFunction('canvasCloseCampaign', {
    session_id: sessionId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    action,
  }, 'Canvas campaign could not be closed. Rep assignments remain active.');
}

export async function listMyCanvasCampaigns() {
  const data = await invokeProductionFunction('canvasListCampaigns', {}, 'Canvas campaigns could not be loaded.');
  return {
    ...data,
    campaigns: Array.isArray(data.campaigns) ? data.campaigns : [],
  };
}

export function quarantineInvalidCanvasCampaigns() {
  return invokeProductionFunction('canvasQuarantineInvalidCampaigns', {
    confirmation: 'QUARANTINE_INVALID_CANVAS_RECORDS',
  }, 'Invalid Canvas records could not be quarantined.');
}

export async function getMyCanvasAssignments({ sessionId } = {}) {
  const data = await invokeProductionFunction(
    'canvasGetMyAssignments',
    sessionId ? { session_id: sessionId } : {},
    'Canvas assignments are temporarily unavailable.'
  );
  return {
    ...data,
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  };
}

export async function getCanvasCampaignMap({ campaignId, includeEvents = false }) {
  if (!campaignId) {
    throw new CanvasProductionError('Choose a Canvas campaign before loading its shared map.', {
      code: 'CANVAS_CAMPAIGN_REQUIRED',
    });
  }
  const data = await invokeProductionFunction('canvasGetCampaignMap', {
    campaign_id: campaignId,
    include_events: includeEvents === true,
  }, 'The shared Canvas campaign map could not be loaded.');
  return {
    ...data,
    campaign: data?.campaign || null,
    pins: Array.isArray(data?.pins) ? data.pins : [],
    events: Array.isArray(data?.events) ? data.events : [],
    outcome_counts: data?.outcome_counts && typeof data.outcome_counts === 'object' ? data.outcome_counts : {},
    zone_counts: data?.zone_counts && typeof data.zone_counts === 'object' ? data.zone_counts : {},
  };
}

export function logCanvasHouseDecision({
  campaignId,
  zoneId,
  idempotencyKey,
  point,
  outcome,
  note,
  address,
  unitLabel,
  buildingFeatureId,
  pinId,
  clientRecordedAt,
}) {
  return invokeProductionFunction('canvasLogHouseDecision', {
    campaign_id: campaignId,
    zone_id: zoneId,
    idempotency_key: idempotencyKey,
    point,
    outcome,
    ...(clientRecordedAt ? { client_recorded_at: clientRecordedAt } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(address?.trim() ? { address: address.trim() } : {}),
    ...(unitLabel?.trim() ? { unit_label: unitLabel.trim() } : {}),
    ...(buildingFeatureId ? { building_feature_id: buildingFeatureId } : {}),
    ...(pinId ? { pin_id: pinId } : {}),
  }, 'This house decision could not be synced. Retry before leaving the house.');
}
