import { base44 } from '@/api/base44Client';

const CANVAS_ANALYSIS_JOB_STORAGE_PREFIX = 'fk_canvasAnalysisJob_v2';

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

async function invokeCanvasOperationalFunction(functionName, payload, fallbackMessage, { allowPartial = false } = {}) {
  try {
    const response = await base44.functions.invoke(functionName, payload);
    const data = responseBody(response);
    if (data?.error || (!allowPartial && data?.success === false)) {
      throw new CanvasProductionError(data.message || data.error || fallbackMessage, {
        code: data.code || data.error || 'CANVAS_REQUEST_REJECTED',
        status: response?.status || null,
        details: data,
      });
    }
    if (data?.success !== true && !(allowPartial && Array.isArray(data?.results))) {
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
  }, 'Residential evidence analysis could not be started.');
}

export function getCanvasAnalysisStatus({ jobId } = {}) {
  if (!jobId) {
    throw new CanvasProductionError('A Canvas analysis job is required before progress can be loaded.', {
      code: 'CANVAS_ANALYSIS_JOB_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasGetAnalysisStatus', { job_id: jobId }, 'Canvas analysis progress could not be loaded.');
}

export function cancelCanvasAnalysis({ jobId } = {}) {
  if (!jobId) {
    throw new CanvasProductionError('A Canvas analysis job is required before it can be cancelled.', {
      code: 'CANVAS_ANALYSIS_JOB_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasCancelAnalysis', { job_id: jobId }, 'Canvas analysis could not be cancelled.');
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(new CanvasProductionError('Canvas analysis polling was cancelled.', {
      code: 'CANVAS_ANALYSIS_CANCELLED',
    }));
  }
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(new CanvasProductionError('Canvas analysis polling was cancelled.', {
        code: 'CANVAS_ANALYSIS_CANCELLED',
      }));
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
  pollIntervalMs = 2_000,
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
    onProgress?.(status);
    if (status.status === 'complete') return status;
    if (status.status === 'failed') {
      throw new CanvasProductionError(status.message || 'Canvas analysis failed.', {
        code: status.error || 'CANVAS_ANALYSIS_FAILED',
        details: status,
      });
    }
    if (status.status === 'cancelled') {
      throw new CanvasProductionError(status.message || 'Canvas analysis was cancelled.', {
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
      throw new CanvasProductionError('Canvas analysis is still running. You can return to this plan safely.', {
        code: 'CANVAS_ANALYSIS_WAIT_TIMEOUT',
        details: status,
      });
    }
    const serverDelay = Number(status.poll_after_ms);
    const delay = Math.max(1_000, Math.min(10_000, Number.isFinite(serverDelay) ? serverDelay : pollIntervalMs));
    await abortableDelay(delay, signal);
    status = null;
  }
}

export async function analyzeCanvasBoundary(options = {}) {
  const started = options.resumeJobId
    ? await getCanvasAnalysisStatus({ jobId: options.resumeJobId })
    : await startCanvasAnalysis(options);
  if (started.status === 'complete') return started;
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
  opportunityCount,
  reason,
} = {}) {
  const targetUnitIds = [...new Set((Array.isArray(streetUnitIds) && streetUnitIds.length
    ? streetUnitIds
    : [streetUnitId]).map((value) => String(value || '').trim()).filter(Boolean))].sort();
  if (!evidenceId || !targetUnitIds.length || !String(reason || '').trim()) {
    throw new CanvasProductionError('Choose a classification target and enter a reason before applying an override.', {
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
    street_unit_ids: targetUnitIds,
    override_canvas_role: canvasRole,
    ...(Number.isFinite(Number(opportunityCount)) ? { opportunity_count: Number(opportunityCount) } : {}),
    override_reason: String(reason).trim(),
  }, 'The classification could not be revised.');
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

export async function getCanvasCampaignMap({ campaignId, includeEvents = false, includePins = true }) {
  if (!campaignId) {
    throw new CanvasProductionError('Choose a Canvas campaign before loading its shared map.', {
      code: 'CANVAS_CAMPAIGN_REQUIRED',
    });
  }
  const data = await invokeProductionFunction('canvasGetCampaignMap', {
    campaign_id: campaignId,
    include_events: includeEvents === true,
    include_pins: includePins !== false,
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

export async function getCanvasAssignmentIndexPage({ cursor = null, limit = 100 } = {}) {
  const data = await invokeCanvasOperationalFunction('canvasGetAssignmentIndex', {
    limit: Math.max(1, Math.min(100, Number(limit) || 100)),
    ...(cursor ? { cursor: String(cursor) } : {}),
  }, 'Canvas assignment discovery is temporarily unavailable.');
  return {
    ...data,
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  };
}

export async function getAllCanvasAssignmentIndex({ maxPages = 100 } = {}) {
  const pageLimit = Math.max(1, Math.min(100, Number(maxPages) || 100));
  const assignments = [];
  const seenAssignments = new Set();
  let cursor = null;
  let serverTime = null;
  for (let page = 0; page < pageLimit; page += 1) {
    const result = await getCanvasAssignmentIndexPage({ cursor, limit: 100 });
    serverTime = result.server_time || serverTime;
    for (const assignment of result.assignments) {
      const assignmentId = String(assignment?.assignment_id || '');
      if (!assignmentId || seenAssignments.has(assignmentId)) {
        throw new CanvasProductionError('Canvas returned an invalid or duplicate assignment index row.', {
          code: 'CANVAS_ASSIGNMENT_INDEX_INVALID',
        });
      }
      seenAssignments.add(assignmentId);
      assignments.push(assignment);
    }
    if (!result.has_more) {
      return { success: true, assignments, server_time: serverTime, complete: true, pages: page + 1 };
    }
    const nextCursor = String(result.next_cursor || '');
    if (!nextCursor || nextCursor === cursor) {
      throw new CanvasProductionError('Canvas assignment discovery did not advance its cursor.', {
        code: 'CANVAS_ASSIGNMENT_INDEX_INVALID',
      });
    }
    cursor = nextCursor;
  }
  throw new CanvasProductionError('Canvas assignment discovery exceeded its safe 100-page limit.', {
    code: 'CANVAS_ASSIGNMENT_INDEX_TOO_LARGE',
  });
}

export function publishCanvasAssignmentPackages({ campaignId, idempotencyKey, validForHours } = {}) {
  if (!campaignId || !idempotencyKey) {
    throw new CanvasProductionError('A deployed Canvas campaign and delivery key are required before rep packages can be published.', {
      code: 'CANVAS_PACKAGE_PUBLICATION_INPUT_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasPublishAssignmentPackages', {
    campaign_id: campaignId,
    publication_idempotency_key: idempotencyKey,
    ...(validForHours !== undefined ? { valid_for_hours: Number(validForHours) } : {}),
  }, 'Canvas territories were deployed, but their offline rep packages could not be published. Retry delivery before reps begin work.');
}

export function getCanvasAssignmentPackage({ campaignId, zoneId, assignmentId, packageVersion } = {}) {
  return invokeProductionFunction('canvasGetAssignmentPackage', {
    ...(assignmentId ? { assignment_id: assignmentId } : { campaign_id: campaignId, zone_id: zoneId }),
    ...(packageVersion !== undefined ? { package_version: Number(packageVersion) } : {}),
  }, 'The current signed Canvas assignment package could not be loaded.');
}

export function getCanvasAssignmentArtifact({ campaignId, zoneId, assignmentId, packageVersion, artifactId } = {}) {
  if (!artifactId) {
    throw new CanvasProductionError('Choose a Canvas package artifact before downloading it.', {
      code: 'CANVAS_ARTIFACT_REQUIRED',
    });
  }
  return invokeProductionFunction('canvasGetAssignmentPackage', {
    ...(assignmentId ? { assignment_id: assignmentId } : { campaign_id: campaignId, zone_id: zoneId }),
    ...(packageVersion !== undefined ? { package_version: Number(packageVersion) } : {}),
    artifact_id: artifactId,
  }, 'A required Canvas assignment artifact could not be loaded.');
}

export async function syncCanvasDecisionBatch({ assignmentId, packageVersion, items = [] } = {}) {
  if (!assignmentId || !Number.isInteger(Number(packageVersion)) || Number(packageVersion) < 1) {
    throw new CanvasProductionError('A current Canvas assignment package is required before decisions can sync.', {
      code: 'CANVAS_ASSIGNMENT_PACKAGE_REQUIRED',
    });
  }
  const decisions = items.map((item) => ({
    ...(item?.payload || {}),
    idempotency_key: String(item?.idempotency_key || item?.idempotencyKey || item?.payload?.idempotency_key || ''),
  }));
  const result = await invokeCanvasOperationalFunction('canvasSyncDecisions', {
    assignment_id: assignmentId,
    package_version: Number(packageVersion),
    decisions,
  }, 'Canvas decisions could not be synchronized.', { allowPartial: true });
  return {
    ...result,
    results: (result.results || []).map((row) => ({
      ...row,
      status: row.ok === true
        ? row.status
        : row.retryable === false
          ? 'rejected'
          : 'retry',
      result: row.ok === true ? { event: row.event, pin: row.pin, progress: row.progress, dnc_active: row.dnc_active } : null,
    })),
  };
}

export function getCanvasChanges({ assignmentId, packageVersion, sinceCursor = 0, limit = 500 } = {}) {
  return invokeCanvasOperationalFunction('canvasGetChanges', {
    assignment_id: assignmentId,
    package_version: Number(packageVersion),
    since_cursor: Number(sinceCursor || 0),
    limit: Math.max(1, Math.min(500, Number(limit) || 500)),
  }, 'Canvas map changes could not be loaded.');
}

export function getCanvasCampaignSummary({ campaignId } = {}) {
  if (!campaignId) {
    throw new CanvasProductionError('Choose a Canvas campaign before loading progress.', {
      code: 'CANVAS_CAMPAIGN_REQUIRED',
    });
  }
  return invokeCanvasOperationalFunction('canvasGetCampaignSummary', {
    campaign_id: campaignId,
  }, 'Canvas campaign progress could not be loaded.');
}

export function getCanvasViewportPins({ campaignId, bounds, afterCursor = 0, afterId = '', limit = 250 } = {}) {
  if (!campaignId || !bounds) {
    throw new CanvasProductionError('Choose a Canvas campaign and visible map area before loading decisions.', {
      code: 'CANVAS_VIEWPORT_REQUIRED',
    });
  }
  return invokeCanvasOperationalFunction('canvasGetViewportPins', {
    campaign_id: campaignId,
    bounds: {
      west: Number(bounds.west),
      south: Number(bounds.south),
      east: Number(bounds.east),
      north: Number(bounds.north),
    },
    after_cursor: Number(afterCursor || 0),
    after_id: String(afterId || ''),
    limit: Math.max(1, Math.min(500, Number(limit) || 250)),
  }, 'Canvas decisions in this map area could not be loaded.');
}