export const SALE_OUTCOME = 'SOLD';

export const SALE_OUTCOME_OPTIONS = [
  { value: 'SOLD', label: 'Sold' },
  { value: 'CALLBACK', label: 'Callback' },
  { value: 'NO_ANSWER', label: 'No Answer' },
  { value: 'HARD_NO', label: 'Not Interested' },
  { value: 'NOT_MOVED_IN', label: 'Not Moved In' },
  { value: 'DM_NOT_HOME', label: 'Decision Maker Not Home' },
  { value: 'ELIGIBLE', label: 'Todo' },
];

export function normalizeSaleEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseOptionalSaleAmount(value) {
  const text = String(value ?? '').trim();
  if (!text) return { value: null, error: '' };

  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(text)) {
    return { value: null, error: 'Enter a valid amount with no more than two decimal places.' };
  }

  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) {
    return { value: null, error: 'Enter a valid amount of zero or more.' };
  }

  return { value: amount, error: '' };
}

export function extractSaleNote(log) {
  if (Object.prototype.hasOwnProperty.call(log || {}, 'description')) {
    return String(log?.description || '').trim();
  }

  const match = String(log?.raw_input_text || '').match(/Note:\s*(.+?)(\s*\||$)/i);
  return match?.[1]?.trim() || '';
}

function propertyAddress(property) {
  if (!property) return '';
  const street = [property.house_number, property.street_name].filter(Boolean).join(' ').trim();
  const locality = [property.city, property.state, property.zip_code || property.zip].filter(Boolean).join(', ');
  return property.full_address || property.address || [street, locality].filter(Boolean).join(', ');
}

function flattenProperties(properties = [], routes = []) {
  const candidates = [...(Array.isArray(properties) ? properties : [])];
  for (const route of Array.isArray(routes) ? routes : []) {
    const routeProperties = route?.allProperties || route?.properties || [];
    if (Array.isArray(routeProperties)) candidates.push(...routeProperties);
  }
  return candidates;
}

export function hasRecordedSaleAmount(log) {
  if (log?.sale_amount === null || log?.sale_amount === undefined || log?.sale_amount === '') return false;
  return Number.isFinite(Number(log.sale_amount));
}

export function buildSalesRows({ logs = [], properties = [], routes = [], members = [], currentUser = null } = {}) {
  const propertyMap = new Map();
  for (const property of flattenProperties(properties, routes)) {
    if (property?.address_hash) propertyMap.set(String(property.address_hash), property);
    if (property?.legacy_hash) propertyMap.set(String(property.legacy_hash), property);
  }

  const routeMap = new Map((Array.isArray(routes) ? routes : [])
    .filter((route) => route?.id)
    .map((route) => [String(route.id), route]));
  const memberMap = new Map((Array.isArray(members) ? members : [])
    .map((member) => [normalizeSaleEmail(member?.email), member])
    .filter(([email]) => email));
  const currentUserEmail = normalizeSaleEmail(currentUser?.email || currentUser?.data?.email);

  return (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log?.parsed_status || '').toUpperCase() === SALE_OUTCOME)
    .map((log) => {
      const property = propertyMap.get(String(log?.address_hash || '')) || null;
      const route = routeMap.get(String(log?.route_id || '')) || null;
      const repEmail = normalizeSaleEmail(log?.created_by);
      const member = memberMap.get(repEmail) || null;
      const recordedAmount = hasRecordedSaleAmount(log);
      const fallbackRepName = repEmail && repEmail === currentUserEmail
        ? currentUser?.full_name || currentUser?.name
        : null;
      const createdAt = log?.sale_date || log?.created_date || null;

      return {
        id: log?.id || `${log?.address_hash || 'sale'}-${createdAt || ''}`,
        log,
        address: log?.property_address || log?.full_address || propertyAddress(property) || log?.address_hash || 'Unknown property',
        homeowner: log?.homeowner_name || property?.owner_full_name || property?.ownerFullName || property?.owner_name || 'Unknown homeowner',
        amount: recordedAmount ? Number(log.sale_amount) : null,
        amountRecorded: recordedAmount,
        createdAt,
        repEmail,
        repName: log?.rep_name || member?.name || fallbackRepName || (repEmail ? repEmail.split('@')[0] : 'Unknown rep'),
        routeName: log?.route_name || route?.name || 'No route recorded',
        outcome: String(log?.parsed_status || SALE_OUTCOME).toUpperCase(),
        notes: extractSaleNote(log),
      };
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || '') || 0;
      const rightTime = Date.parse(right.createdAt || '') || 0;
      return rightTime - leftTime;
    });
}

export function buildSaleUpdatePayload({ amountInput = '', outcome = SALE_OUTCOME, notes = '' } = {}) {
  const normalizedOutcome = String(outcome || '').toUpperCase();
  if (!SALE_OUTCOME_OPTIONS.some((option) => option.value === normalizedOutcome)) {
    return { payload: null, error: 'Choose a supported outcome.' };
  }

  const parsedAmount = normalizedOutcome === SALE_OUTCOME
    ? parseOptionalSaleAmount(amountInput)
    : { value: null, error: '' };
  if (parsedAmount.error) return { payload: null, error: parsedAmount.error };
  const normalizedNotes = String(notes || '').trim();

  return {
    payload: {
      parsed_status: normalizedOutcome,
      sale_amount: parsedAmount.value,
      description: normalizedNotes,
      raw_input_text: normalizedNotes
        ? `Outcome corrected to ${normalizedOutcome} | Note: ${normalizedNotes}`
        : `Outcome corrected to ${normalizedOutcome}`,
    },
    error: '',
  };
}

export function salesLogBelongsToScope(log, {
  userEmail = '',
  tenantManagerId = '',
  manager = false,
  memberEmails = [],
} = {}) {
  if (String(log?.parsed_status || '').toUpperCase() !== SALE_OUTCOME) return false;

  const normalizedUserEmail = normalizeSaleEmail(userEmail);
  const creatorEmail = normalizeSaleEmail(log?.created_by);
  const logManagerId = String(log?.manager_id || '');
  const managerId = String(tenantManagerId || '');

  if (!manager) {
    return creatorEmail === normalizedUserEmail && (!logManagerId || !managerId || logManagerId === managerId);
  }

  if (logManagerId) return !!managerId && logManagerId === managerId;
  const legacyEmails = new Set([normalizedUserEmail, ...memberEmails.map(normalizeSaleEmail)].filter(Boolean));
  return !!creatorEmail && legacyEmails.has(creatorEmail);
}
