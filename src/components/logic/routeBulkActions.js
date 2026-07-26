// Extension is explicit: this module is imported directly by node --test, whose
// ESM resolver does not fill it in the way Vite does.
import { withoutHouseNotes } from './outcomeStatus.js';

export const ROUTE_BULK_ACTIONS = Object.freeze({
  TODO: 'TODO',
  CALLBACK: 'CALLBACK',
  RE_KNOCK: 'RE_KNOCK',
  DELETE: 'DELETE',
});

const WORKFLOW_TRANSITIONS = Object.freeze({
  [ROUTE_BULK_ACTIONS.TODO]: {
    parsedStatus: 'ELIGIBLE',
    workflowAction: 'BULK_MOVE_TO_TODO',
    workflowBucket: 'TODO',
    rawInputText: 'Workflow update - moved to Todo',
  },
  [ROUTE_BULK_ACTIONS.CALLBACK]: {
    parsedStatus: 'CALLBACK',
    workflowAction: 'BULK_MOVE_TO_CALLBACK',
    workflowBucket: 'CALLBACK',
    rawInputText: 'Workflow update - moved to Callback',
  },
  [ROUTE_BULK_ACTIONS.RE_KNOCK]: {
    parsedStatus: 'ELIGIBLE',
    workflowAction: 'BULK_MOVE_TO_RE_KNOCK',
    workflowBucket: 'RE_KNOCK',
    rawInputText: 'Workflow update - moved to Re-Knock',
  },
});

const normalizedKey = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

export function getPropertyAliases(property) {
  return [...new Set([
    property?.address_hash,
    property?.legacy_hash,
    property?.id,
  ].map(normalizedKey).filter(Boolean))];
}

export function getPropertySelectionKey(property) {
  return getPropertyAliases(property)[0] || '';
}

export function getVisiblePropertyKeys(properties = []) {
  return [...new Set(properties.map(getPropertySelectionKey).filter(Boolean))];
}

export function togglePropertySelection(selectedKeys, property) {
  const next = new Set(selectedKeys || []);
  const key = getPropertySelectionKey(property);
  if (!key) return next;
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function toggleVisiblePropertySelection(selectedKeys, visibleProperties = []) {
  const next = new Set(selectedKeys || []);
  const visibleKeys = getVisiblePropertyKeys(visibleProperties);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => next.has(key));

  visibleKeys.forEach((key) => {
    if (allVisibleSelected) next.delete(key);
    else next.add(key);
  });
  return next;
}

export function pruneSelectionToProperties(selectedKeys, visibleProperties = []) {
  const visibleKeys = new Set(getVisiblePropertyKeys(visibleProperties));
  return new Set([...(selectedKeys || [])].filter((key) => visibleKeys.has(key)));
}

export function selectionsEqual(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left || []);
  const rightSet = right instanceof Set ? right : new Set(right || []);
  return leftSet.size === rightSet.size && [...leftSet].every((key) => rightSet.has(key));
}

// House notes are excluded here rather than at each call site: this is the one
// chokepoint every workflow helper reads through, and a note is never a
// decision. Without this, saving a note would become the newest log and wipe the
// house's workflow bucket.
export function getLatestInteractionLog(logs = []) {
  return [...withoutHouseNotes(logs)].sort((left, right) => {
    const leftTime = new Date(left?.created_date || 0).getTime();
    const rightTime = new Date(right?.created_date || 0).getTime();
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  })[0] || null;
}

export function getWorkflowBucketFromLogs(logs = []) {
  return getLatestInteractionLog(logs)?.workflow_bucket || null;
}

export function resolveWorkflowEffectiveStatus(derivedStatus, logs = []) {
  const latestLog = getLatestInteractionLog(logs);
  if (
    latestLog?.counts_as_knock === false
    && latestLog?.parsed_status === 'CALLBACK'
    && latestLog?.workflow_action === 'BULK_MOVE_TO_CALLBACK'
  ) {
    return 'CALLBACK';
  }
  if (
    latestLog?.counts_as_knock === false
    && latestLog?.parsed_status === 'ELIGIBLE'
    && ['BULK_MOVE_TO_TODO', 'BULK_MOVE_TO_RE_KNOCK', 'CLEAR_TO_TODO'].includes(latestLog?.workflow_action)
  ) {
    return 'ELIGIBLE';
  }
  return derivedStatus;
}

export function buildWorkflowTransitionLogs(properties = [], action, { routeId = null, managerId = null } = {}) {
  const transition = WORKFLOW_TRANSITIONS[action];
  if (!transition) throw new Error(`Unsupported route workflow action: ${action}`);

  return properties.map((property) => {
    const addressHash = getPropertySelectionKey(property);
    if (!addressHash) throw new Error('A selected route stop is missing its property identifier.');

    return {
      address_hash: addressHash,
      raw_input_text: transition.rawInputText,
      parsed_status: transition.parsedStatus,
      route_id: routeId || null,
      manager_id: managerId || null,
      counts_as_knock: false,
      workflow_action: transition.workflowAction,
      workflow_bucket: transition.workflowBucket,
    };
  });
}

export function removeSelectedRouteStops(routeHashes = [], selectedProperties = []) {
  const selectedAliases = new Set(selectedProperties.flatMap(getPropertyAliases));
  const routeHashSet = new Set((routeHashes || []).map(normalizedKey).filter(Boolean));
  const remainingHashes = [];
  const removedHashes = [];

  (routeHashes || []).forEach((hash) => {
    const normalizedHash = normalizedKey(hash);
    if (normalizedHash && selectedAliases.has(normalizedHash)) removedHashes.push(hash);
    else remainingHashes.push(hash);
  });

  const unmatchedSelectionKeys = selectedProperties
    .filter((property) => !getPropertyAliases(property).some((alias) => routeHashSet.has(alias)))
    .map(getPropertySelectionKey)
    .filter(Boolean);

  return { remainingHashes, removedHashes, unmatchedSelectionKeys };
}

export function orderRoutePropertiesByHashes(routeHashes = [], properties = []) {
  const propertiesByAlias = new Map();
  properties.forEach((property) => {
    getPropertyAliases(property).forEach((alias) => propertiesByAlias.set(alias, property));
  });

  const orderedProperties = [];
  const unmatchedHashes = [];
  (routeHashes || []).forEach((hash) => {
    const normalizedHash = normalizedKey(hash);
    const property = normalizedHash ? propertiesByAlias.get(normalizedHash) : null;
    if (property) orderedProperties.push(property);
    else unmatchedHashes.push(hash);
  });

  return { orderedProperties, unmatchedHashes };
}
