import { fetchAllAnalyticsPages } from './analyticsDateFilter.js';
import { withReadDeadline } from './readRequest.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';
import { isKnockActivityLog } from './interactionLogs.js';

// Analytics uses identifiers, outcomes and dates. Route geometry, raw import
// payloads, contact details and media are not needed to calculate these totals.
export const ANALYTICS_LOG_FIELDS = [
  'id', 'created_date', 'created_by', 'manager_id', 'address_hash',
  'parsed_status', 'sale_amount', 'counts_as_knock', 'workflow_action', 'source', 'description',
];

export const ANALYTICS_ROUTE_FIELDS = [
  'id', 'created_date', 'updated_date', 'created_by', 'manager_id', 'name',
  'status', 'assigned_to', 'assigned_to_name', 'property_hashes', 'metrics',
];

// Fields the analytics route visibility rule reads.
export const ANALYTICS_ROUTE_SCOPE_FIELDS = ['id', 'manager_id', 'assigned_to', 'created_by'];
const ANALYTICS_ROUTE_LIMIT = 500;
const ANALYTICS_ROUTE_ID_BATCH = 100;

const routeRows = (result) => (Array.isArray(result) ? result : (result?.items || []));

/**
 * Reads the same SavedRoute rows as one full read per filter, in the same
 * order, without downloading overlapping groups at full size. A manager's
 * own-tenant read already holds nearly every visible route; the assignee and
 * creator reads repeated those rows with their whole door manifests. They now
 * read only the scope fields, and any visible route the tenant read missed is
 * then read in full by id. Without a tenant filter every group is read in full.
 *
 * @param {(filter: object, limit: number, fields: string[]) => Promise<unknown>} readRoutes
 * @param {{ filters?: object[], tenantFilter?: object | null, isVisible?: (route: any) => boolean }} options
 */
export async function fetchAnalyticsRouteRows(readRoutes, { filters = [], tenantFilter = null, isVisible = () => true } = {}) {
  const read = async (filter, fields, limit = ANALYTICS_ROUTE_LIMIT) => routeRows(await readRoutes(filter, limit, fields));
  const tenantIndex = tenantFilter ? filters.indexOf(tenantFilter) : -1;
  if (tenantIndex < 0) return (await Promise.all(filters.map((filter) => read(filter, ANALYTICS_ROUTE_FIELDS)))).flat();

  const groups = await Promise.all(filters.map((filter, index) => (
    read(filter, index === tenantIndex ? ANALYTICS_ROUTE_FIELDS : ANALYTICS_ROUTE_SCOPE_FIELDS)
  )));
  const fullGroups = new Set([tenantIndex]);
  const fullById = new Map(groups[tenantIndex].filter((route) => route?.id).map((route) => [String(route.id), route]));
  const missingIds = new Set();
  for (const [index, rows] of groups.entries()) {
    if (fullGroups.has(index)) continue;
    const visible = rows.filter(isVisible);
    if (visible.some((route) => !route?.id)) {
      // A visible row without an id cannot be re-read by id; keep its group whole.
      groups[index] = await read(filters[index], ANALYTICS_ROUTE_FIELDS);
      fullGroups.add(index);
      continue;
    }
    visible.forEach((route) => { if (!fullById.has(String(route.id))) missingIds.add(String(route.id)); });
  }
  const ids = [...missingIds];
  for (let start = 0; start < ids.length; start += ANALYTICS_ROUTE_ID_BATCH) {
    const batch = ids.slice(start, start + ANALYTICS_ROUTE_ID_BATCH);
    (await read({ id: { $in: batch } }, ANALYTICS_ROUTE_FIELDS, batch.length))
      .forEach((route) => { if (route?.id) fullById.set(String(route.id), route); });
  }
  // Rows the visibility rule rejects are dropped by the caller anyway.
  return groups.flatMap((rows, index) => (fullGroups.has(index)
    ? rows
    : rows.filter(isVisible).map((route) => fullById.get(String(route.id))).filter(Boolean)));
}

export const ANALYTICS_APPOINTMENT_FIELDS = [
  'id', 'created_date', 'created_by', 'manager_id', 'scheduled_date', 'status',
  'assigned_rep', 'assigned_rep_name', 'industry', 'address_hash', 'full_address',
];

// Saved routes already carry their complete door manifest. Counting route
// inventory must not require resolving every door's map coordinates first.
export function collectAnalyticsRouteProperties(routes = []) {
  const byHash = new Map();
  for (const route of routes) {
    const embedded = route?.allProperties || route?.properties || [];
    for (const property of Array.isArray(embedded) ? embedded : []) {
      const hash = property?.address_hash || property?.id;
      if (hash && !byHash.has(hash)) byHash.set(hash, property);
    }
    for (const hash of Array.isArray(route?.property_hashes) ? route.property_hashes : []) {
      if (hash && !byHash.has(hash)) byHash.set(hash, { address_hash: hash });
    }
  }
  return [...byHash.values()];
}

// Keep both timestamp and legacy calendar-date values. A date-only string must
// use the local calendar boundary, rather than a UTC midnight interpretation.
export function getAnalyticsAppointmentDateFilter(window) {
  if (window?.isAllTime || !window?.start || !window?.end) return {};
  const calendarDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return {
    $or: [
      { scheduled_date: { $gte: window.start.toISOString(), $lt: window.end.toISOString() } },
      { scheduled_date: { $gte: calendarDate(window.start), $lt: calendarDate(window.end) } },
    ],
  };
}
export async function fetchPersonalAnalyticsLogs(entity, creatorEmails, {
  selectedWindow = null,
  allTime = false,
  read = withReadDeadline,
} = {}) {
  const emails = [...new Set(creatorEmails.filter(Boolean))];
  const queries = emails.flatMap((email) => {
    const readPage = (filter, limit, skip) => read(() => entity.filter(
      { created_by: email, ...filter }, '-created_date', limit, skip, ANALYTICS_LOG_FIELDS
    ));
    const recent = allTime
      ? fetchAllAnalyticsPages((limit, skip) => readPage({}, limit, skip))
      : readPage({}, 5000, 0);
    const historical = selectedWindow?.start && selectedWindow?.end
      ? fetchAllAnalyticsPages((limit, skip) => readPage({
        created_date: { $gte: selectedWindow.start.toISOString(), $lt: selectedWindow.end.toISOString() },
      }, limit, skip))
      : null;
    // A historical day must not wait for the recent-history request to finish.
    return [recent, historical].filter(Boolean);
  });
  const groups = await Promise.all(queries);
  return groups.flatMap((group) => Array.isArray(group) ? group : (group?.items || []));
}

export function adjustAnalyticsStatusCounts(statusCounts = {}, properties = []) {
  const counts = { ...statusCounts };
  for (const property of properties) {
    const baseline = ['HARD_NO', 'DO_NOT_KNOCK', 'UNVERIFIED'].includes(property?.original_status)
      ? property.original_status
      : 'ELIGIBLE';
    const effective = property?.effective_status || baseline;
    if (effective === baseline) continue;
    counts[baseline] = Math.max(0, Number(counts[baseline] || 0) - 1);
    counts[effective] = Number(counts[effective] || 0) + 1;
  }
  return counts;
}

export async function fetchAnalyticsTerritorySummary(hashes, fetchSummary) {
  const uniqueHashes = [...new Set(hashes.filter(Boolean))];
  const batches = [];
  for (let offset = 0; offset < uniqueHashes.length; offset += 5000) {
    batches.push(uniqueHashes.slice(offset, offset + 5000));
  }
  if (!batches.length) batches.push([]);
  const responses = await mapWithConcurrency(batches, async (batch) => {
    const response = await fetchSummary(batch);
    if (!response?.success || !Number.isFinite(response.count) || response.count < 0 ||
        !response.status_counts || !Array.isArray(response.properties)) {
      throw new Error('Unable to load territory analytics.');
    }
    return response;
  }, 2);
  const first = responses[0];
  const countSignature = (response) => JSON.stringify(Object.entries(response.status_counts).sort());
  if (responses.some((response) => response.count !== first.count || countSignature(response) !== countSignature(first))) {
    throw new Error('Territory changed while loading analytics. Please try again.');
  }
  const matched = new Map();
  responses.forEach((response) => response.properties.forEach((property) => {
    const key = property?.address_hash || property?.id;
    if (key) matched.set(key, property);
  }));
  return { count: first.count, statusCounts: first.status_counts, properties: [...matched.values()] };
}

export function buildAnalyticsRouteStats(routes = [], logs = []) {
  const activityByHash = new Map();
  for (const log of logs) {
    if (!log?.address_hash || !isKnockActivityLog(log)) continue;
    const bucket = activityByHash.get(log.address_hash) || { count: 0, sales: 0 };
    bucket.count += 1;
    if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) bucket.sales += 1;
    activityByHash.set(log.address_hash, bucket);
  }
  return routes.filter((route) => route.status !== 'ARCHIVED').map((route) => {
    const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
    const hydratedCount = Array.isArray(route.allProperties) ? route.allProperties.length
      : Array.isArray(route.properties) ? route.properties.length : 0;
    const total = Math.max(hydratedCount, route.metrics?.house_count || route.houseCount || 0, hashes.length);
    let uniqueKnocked = 0;
    let sales = 0;
    let logCount = 0;
    for (const hash of new Set(hashes)) {
      const activity = activityByHash.get(hash);
      if (!activity) continue;
      uniqueKnocked += 1;
      sales += activity.sales;
      logCount += activity.count;
    }
    return { ...route, uniqueKnocked, total, percent: total ? Math.round(uniqueKnocked / total * 100) : 0, sales, logCount };
  }).sort((a, b) => {
    const order = { IN_PROGRESS: 0, ACTIVE: 1, PENDING: 2, COMPLETED: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });
}

export function countAnalyticsWorkedDoors(logs, hashes, requireMembership = false) {
  const inventory = new Set(hashes);
  return new Set(logs.map((log) => log.address_hash)
    .filter((hash) => hash && (!requireMembership || inventory.has(hash)))).size;
}

export function requireCompleteAnalyticsRouteProperties(routes = []) {
  for (const route of routes) {
    const loaded = route?.allProperties || route?.properties || [];
    const loadedHashes = new Set(loaded.flatMap((property) => [property?.address_hash || property?.id, property?.legacy_hash]).filter(Boolean));
    if ((route?.property_hashes || []).some((hash) => !loadedHashes.has(hash))) {
      throw new Error('Some door statuses are unavailable. Please try again.');
    }
  }
  return routes;
}
