import { base44 } from '@/api/base44Client';

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
