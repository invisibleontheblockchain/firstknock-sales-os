import { base44 } from '@/api/base44Client';

const FUNCTION_NAME = 'fieldRoutesIntegration';

export const FIELDROUTES_ACTIONS = Object.freeze({
  capability: 'capability',
  saveConnection: 'save_connection',
  testConnection: 'test_connection',
  listServiceTypes: 'list_service_types',
  disconnect: 'disconnect',
  listActivity: 'list_activity',
  retryRequest: 'retry_request',
  scheduleInspection: 'schedule_inspection',
  getStatuses: 'get_statuses',
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  manager_required: 'Only a team manager can manage this integration.',
  manager_account_unavailable: 'FirstKnock could not resolve this team account. Sign in again or contact support.',
  forbidden: 'You do not have permission to manage this integration.',
  team_membership_required: 'An active FirstKnock team assignment is required.',
  integration_disabled: 'FieldRoutes is not enabled for this FirstKnock account yet.',
  not_configured: 'Save the FieldRoutes connection before testing it.',
  fieldroutes_not_connected: 'A manager must connect FieldRoutes before reps can schedule inspections.',
  fieldroutes_service_type_required: 'A manager must choose the initial inspection service before reps can schedule.',
  credentials_required: 'Enter both the API key and authentication token.',
  authentication_failed: 'FieldRoutes rejected the saved credentials. Re-enter both credentials and try again.',
  invalid_credentials: 'FieldRoutes rejected the saved credentials. Re-enter both credentials and try again.',
  provider_authentication_failed: 'FieldRoutes rejected the saved credentials. Ask a manager to reconnect the integration.',
  invalid_environment: 'Choose a supported FieldRoutes environment.',
  invalid_subdomain: 'Enter the FieldRoutes account subdomain shown in the customer account URL.',
  invalid_account_host: 'The FieldRoutes account host is not allowed.',
  invalid_provider_host: 'Choose the approved FieldRoutes production account or staging environment.',
  provider_host_invalid: 'The saved FieldRoutes account host is not allowed. Reconnect the integration.',
  provider_endpoint_invalid: 'FirstKnock blocked an unsupported FieldRoutes request.',
  office_required: 'Choose the FieldRoutes office that should receive these leads.',
  service_type_required: 'Choose the initial service type for inspections.',
  service_type_invalid: 'That service type is no longer available. Reload the service types and choose another.',
  rate_limited: 'FieldRoutes is temporarily rate limited. Wait before trying again.',
  provider_rate_limited: 'FieldRoutes is temporarily rate limited. FirstKnock will retry when allowed.',
  provider_unavailable: 'FieldRoutes is temporarily unavailable. Try again shortly.',
  provider_timeout: 'FieldRoutes did not confirm the request in time. FirstKnock will keep it pending safely.',
  provider_network_error: 'FieldRoutes could not be reached. FirstKnock will keep the request pending safely.',
  provider_server_error: 'FieldRoutes could not confirm the request. FirstKnock will retry safely.',
  provider_invalid_json: 'FieldRoutes returned an unreadable response. Try again shortly.',
  provider_validation_failed: 'FieldRoutes rejected the inspection details. Review the required contact and address fields.',
  provider_request_rejected: 'FieldRoutes rejected the request. Review the integration setup and inspection details.',
  provider_create_id_invalid: 'FieldRoutes did not confirm the created record. Review the request before retrying.',
  request_not_retryable: 'This request needs review and cannot be retried automatically.',
  ambiguous_write: 'FieldRoutes may have accepted this request. Review it before retrying to avoid a duplicate appointment.',
  fieldroutes_ack_missing: 'FieldRoutes did not return a durable request acknowledgement. The request remains pending.',
  route_not_found: 'This FirstKnock route is no longer available.',
  route_not_assigned: 'This route is not assigned to the active rep.',
  route_not_authorized: 'This route does not belong to the active FirstKnock team.',
  property_not_on_route: 'This house is not part of the active assigned route.',
  canvas_campaign_untrusted: 'This Canvas campaign is no longer active or trusted.',
  canvas_zone_not_found: 'This Canvas area is no longer available.',
  canvas_zone_not_assigned: 'This Canvas area is not assigned to the active rep.',
  canvas_pin_untrusted: 'This house pin is not part of the active Canvas area.',
  canvas_pin_evidence_mismatch: 'This house pin belongs to an older Canvas analysis.',
  canvas_pin_revision_mismatch: 'This house pin belongs to an older Canvas revision.',
  canvas_pin_street_mismatch: 'This house pin no longer matches its assigned street.',
  canvas_street_mismatch: 'This house is not owned by the active Canvas street assignment.',
  canvas_address_mismatch: 'The house address does not match the verified Canvas pin.',
  canvas_signing_unavailable: 'Canvas campaign verification is temporarily unavailable.',
  ambiguous_canvas_territory: 'This house overlaps multiple Canvas areas and needs manager review.',
  house_outside_assigned_zone: 'This house is outside the active rep area.',
  house_outside_campaign: 'This house is outside the active Canvas campaign.',
  house_too_far_from_owned_street: 'This house is too far from the rep’s assigned Canvas street.',
  invalid_canvas_location: 'Choose a verified house location inside the active Canvas area.',
  invalid_source: 'FirstKnock could not verify the route or Canvas source for this inspection.',
  invalid_request: 'Review the required inspection details and try again.',
  encryption_unavailable: 'Secure FieldRoutes credential storage is not configured. Contact FirstKnock support.',
  encrypted_record_invalid: 'The saved FieldRoutes connection must be reconnected by a manager.',
});

function normalizeFunctionResponse(response) {
  return response?.data ?? response;
}

function normalizeErrorCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 80);
}

function errorCodeFrom(value) {
  return normalizeErrorCode(
    value?.error_code
    || value?.code
    || (typeof value?.error === 'string' ? value.error : '')
    || value?.response?.data?.error_code
    || value?.response?.data?.code
    || (typeof value?.response?.data?.error === 'string' ? value.response.data.error : '')
    || value?.data?.error_code
    || value?.data?.code
    || (typeof value?.data?.error === 'string' ? value.data.error : '')
  ) || 'fieldroutes_request_failed';
}

function httpStatusFrom(value) {
  const candidates = [
    value?.response?.status,
    value?.status,
    value?.http_status,
    value?.response?.data?.status,
    value?.response?.data?.http_status,
    value?.data?.status,
    value?.data?.http_status,
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return undefined;
}

function retryableFrom(value) {
  const candidates = [
    value?.retryable,
    value?.response?.data?.retryable,
    value?.data?.retryable,
  ];
  return candidates.find((candidate) => typeof candidate === 'boolean');
}

function safeErrorFrom(value, fallback = 'FieldRoutes could not complete that request. Try again or contact support.') {
  const code = errorCodeFrom(value);
  const message = SAFE_ERROR_MESSAGES[code] || fallback;
  const error = new Error(message);
  error.name = 'FieldRoutesIntegrationError';
  error.code = code;
  const status = httpStatusFrom(value);
  if (status !== undefined) error.status = status;
  const retryable = retryableFrom(value);
  if (retryable !== undefined) error.retryable = retryable;
  return error;
}

function resolvedFailure(result) {
  if (!result || typeof result !== 'object') return false;
  return result.success === false
    || result.ok === false
    || result.accepted === false
    || Boolean(result.error_code)
    || Boolean(result.error && !result.request && !result.request_id);
}

export async function invokeFieldRoutes(action, payload = {}) {
  try {
    const response = await base44.functions.invoke(FUNCTION_NAME, { ...payload, action });
    const result = normalizeFunctionResponse(response);
    if (resolvedFailure(result)) {
      const error = safeErrorFrom(result);
      const responseStatus = httpStatusFrom(response);
      if (error.status === undefined && responseStatus !== undefined) error.status = responseStatus;
      const responseRetryable = retryableFrom(response);
      if (error.retryable === undefined && responseRetryable !== undefined) error.retryable = responseRetryable;
      throw error;
    }
    return result;
  } catch (error) {
    if (error?.name === 'FieldRoutesIntegrationError') throw error;
    throw safeErrorFrom(error);
  }
}

export const getFieldRoutesCapability = () => invokeFieldRoutes(FIELDROUTES_ACTIONS.capability);

export const saveFieldRoutesConnection = (connection) => (
  invokeFieldRoutes(FIELDROUTES_ACTIONS.saveConnection, connection)
);

export const testFieldRoutesConnection = () => invokeFieldRoutes(FIELDROUTES_ACTIONS.testConnection);

export const listFieldRoutesServiceTypes = (payload = {}) => (
  invokeFieldRoutes(FIELDROUTES_ACTIONS.listServiceTypes, payload)
);

export const disconnectFieldRoutes = () => invokeFieldRoutes(FIELDROUTES_ACTIONS.disconnect);

export const listFieldRoutesActivity = (payload = {}) => (
  invokeFieldRoutes(FIELDROUTES_ACTIONS.listActivity, payload)
);

export const retryFieldRoutesRequest = (payload) => (
  invokeFieldRoutes(FIELDROUTES_ACTIONS.retryRequest, payload)
);

export async function scheduleFieldRoutesInspection(intent) {
  const result = await invokeFieldRoutes(FIELDROUTES_ACTIONS.scheduleInspection, intent);
  const durableAcknowledgement = result?.accepted === true
    || result?.idempotent === true
    || Boolean(result?.request_id)
    || Boolean(result?.request?.id);
  if (!durableAcknowledgement) throw safeErrorFrom({ code: 'fieldroutes_ack_missing' });
  return result;
}

export const getFieldRoutesStatuses = (payload = {}) => (
  invokeFieldRoutes(FIELDROUTES_ACTIONS.getStatuses, payload)
);
