export const FIELDROUTES_COPY = Object.freeze({
  synced: 'Inspection sent to FieldRoutes — office scheduling pending',
  serverPending: 'Saved to FirstKnock — FieldRoutes sync pending',
  devicePending: 'Saved on this device — not visible to the office yet.',
});

const ATTENTION_STATES = new Set([
  'blocked_auth',
  'blocked_config',
  'needs_review',
  'needs_review_ambiguous',
  'needs_review_customer_match',
  'review_required',
  'failed',
  'failed_permanent',
]);

const TERMINAL_STATES = new Set([
  'synced',
  'superseded',
  ...ATTENTION_STATES,
]);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function isFieldRoutesCapabilityReady(capability) {
  const value = capability?.capability || capability;
  if (!value || typeof value !== 'object') return false;
  const configured = value.configured === true
    || value.is_configured === true
    || value.connected === true
    || value.is_connected === true;
  const configReady = value.config_ready === true
    || value.ready === true
    || value.status === 'connected';
  return configured && configReady;
}

export function fieldRoutesRequestState(value) {
  return normalized(
    value?.state
    || value?.status
    || value?.sync_state
    || value?.request?.state
    || value?.request?.status
    || value?.inspection?.state
    || value?.inspection?.status,
  );
}

export function fieldRoutesStatusRows(response) {
  if (Array.isArray(response)) return response.filter(Boolean);
  if (Array.isArray(response?.statuses)) return response.statuses.filter(Boolean);
  if (Array.isArray(response?.requests)) return response.requests.filter(Boolean);
  if (Array.isArray(response?.items)) return response.items.filter(Boolean);
  if (response?.statuses && typeof response.statuses === 'object') {
    return Object.entries(response.statuses).map(([sourceKey, status]) => ({ source_key: sourceKey, ...(status || {}) }));
  }
  if (response?.by_source && typeof response.by_source === 'object') {
    return Object.entries(response.by_source).map(([sourceKey, status]) => ({ source_key: sourceKey, ...(status || {}) }));
  }
  return [];
}

export function isFieldRoutesTerminalStatus(value) {
  return TERMINAL_STATES.has(fieldRoutesRequestState(value));
}

export function preferFieldRoutesStatus(localStatus, serverStatus) {
  if (!serverStatus) return localStatus || null;
  // Once a durable row exists, the server outbox is authoritative. A local
  // acknowledgement or attention state must never shadow a newer worker
  // checkpoint, including a manager-triggered retry back to a pending state.
  return serverStatus;
}

export function fieldRoutesServerAcknowledged(value) {
  if (!value || typeof value !== 'object') return false;
  const durableRequestId = value.request_id || value.request?.id || value.inspection?.id;
  return Boolean(durableRequestId);
}

export function fieldRoutesAppointmentId(value) {
  const candidates = [
    value?.appointment_id,
    value?.fieldroutes_appointment_id,
    value?.request?.appointment_id,
    value?.request?.fieldroutes_appointment_id,
    value?.result?.appointment_id,
    value?.result?.fieldroutes_appointment_id,
    value?.result?.request?.appointment_id,
    value?.result?.request?.fieldroutes_appointment_id,
  ];
  const appointmentId = candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => /^[1-9]\d*$/.test(candidate));
  return appointmentId || null;
}

export function fieldRoutesDelivery(value) {
  const state = fieldRoutesRequestState(value);
  if (state === 'synced' || value?.synced === true || value?.fieldroutes_appointment_id || value?.appointment_id) {
    return { kind: 'synced', state: state || 'synced', copy: FIELDROUTES_COPY.synced };
  }
  if (ATTENTION_STATES.has(state)) {
    return {
      kind: 'attention',
      state,
      copy: String(value?.safe_message || value?.message || 'FieldRoutes needs manager review before this inspection can finish syncing.'),
    };
  }
  if (state === 'superseded') {
    return { kind: 'superseded', state, copy: 'Replaced by a corrected inspection request.' };
  }
  return { kind: 'server_pending', state: state || 'accepted', copy: FIELDROUTES_COPY.serverPending };
}

export function fieldRoutesStatusPresentation(value) {
  const localKind = normalized(value?.kind || value?.delivery);
  if (localKind === 'device_pending' || localKind === 'offline') {
    return { label: FIELDROUTES_COPY.devicePending, tone: 'device' };
  }
  const delivery = fieldRoutesDelivery(value || {});
  if (delivery.kind === 'synced') return { label: FIELDROUTES_COPY.synced, tone: 'synced' };
  if (delivery.kind === 'attention') return { label: delivery.copy, tone: 'attention' };
  if (delivery.kind === 'superseded') return { label: delivery.copy, tone: 'superseded' };
  return { label: FIELDROUTES_COPY.serverPending, tone: 'pending' };
}

export function splitContactName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function findFieldRoutesStatus(response, predicate) {
  const matches = fieldRoutesStatusRows(response).filter(predicate);
  return matches.find((row) => fieldRoutesRequestState(row) !== 'superseded') || matches[0] || null;
}
