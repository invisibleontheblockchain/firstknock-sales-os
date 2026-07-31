export const FOLLOW_UP_STATUSES = new Set(['NO_ANSWER', 'CALLBACK', 'NOT_MOVED_IN', 'DM_NOT_HOME']);

export function getRouteHashes(route) {
  const hashes = route?.property_hashes || (route?.properties || []).map(p => p.address_hash || p.id);
  return [...new Set((hashes || []).filter(Boolean))];
}

export function getRerunProperties(route, selectedHashes) {
  const selected = new Set(selectedHashes || []);
  return (route?.properties || route?.allProperties || []).filter((property) => {
    const aliases = [property?.address_hash, property?.legacy_hash, property?.id].filter(Boolean);
    return aliases.some((hash) => selected.has(hash));
  });
}

export function getRouteOutcomeStats(route, logs = []) {
  const routeHashes = getRouteHashes(route);
  const canonicalByHash = new Map(routeHashes.map(hash => [hash, hash]));

  (route?.properties || route?.allProperties || []).forEach((property) => {
    const canonical = property.address_hash || property.legacy_hash || property.id;
    if (!canonical) return;
    if (property.address_hash) canonicalByHash.set(property.address_hash, canonical);
    if (property.legacy_hash) canonicalByHash.set(property.legacy_hash, canonical);
    if (property.id) canonicalByHash.set(property.id, canonical);
  });

  const latestByHash = new Map();
  [...logs]
    .filter(log => log?.address_hash && canonicalByHash.has(log.address_hash))
    .sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0))
    .forEach((log) => {
      const canonical = canonicalByHash.get(log.address_hash);
      if (canonical && !latestByHash.has(canonical)) latestByHash.set(canonical, log.parsed_status || 'OTHER');
    });

  const byStatus = { SOLD: 0, NO_ANSWER: 0, CALLBACK: 0, HARD_NO: 0, NOT_MOVED_IN: 0, DM_NOT_HOME: 0, OTHER: 0 };
  latestByHash.forEach((status) => {
    if (byStatus[status] === undefined) byStatus.OTHER += 1;
    else byStatus[status] += 1;
  });

  return { total: routeHashes.length, knocked: latestByHash.size, byStatus, latestByHash, routeHashes };
}

function buildCanonicalAliasMap(route) {
  const aliasMap = new Map();
  (route?.properties || route?.allProperties || []).forEach((property) => {
    const canonical = property?.address_hash || property?.legacy_hash || property?.id;
    if (!canonical) return;
    [property.address_hash, property.legacy_hash, property.id]
      .filter(Boolean)
      .forEach((alias) => aliasMap.set(alias, canonical));
  });
  return aliasMap;
}

// A completed route's property_hashes can hold multiple aliases for the same
// door (address_hash + legacy_hash + record id). Reruns rebuild their doors by
// hydrating each stored hash, so aliases must be collapsed to one hash per
// property or every aliased door appears duplicated on the rerun route.
export function dedupeRerunHashes(route, hashes) {
  const aliasMap = buildCanonicalAliasMap(route);
  const seen = new Set();
  const result = [];
  (hashes || []).forEach((hash) => {
    if (!hash) return;
    const canonical = aliasMap.get(hash) || hash;
    if (seen.has(canonical)) return;
    seen.add(canonical);
    result.push(canonical);
  });
  return result;
}

export function getRerunHashes(route, stats, filter) {
  const filtered = filter === 'all' ? stats.routeHashes : stats.routeHashes.filter((hash) => {
    const status = stats.latestByHash.get(hash);
    if (filter === 'no_answer') return status === 'NO_ANSWER';
    if (filter === 'callbacks') return status === 'CALLBACK';
    if (filter === 'unsold') return !status || FOLLOW_UP_STATUSES.has(status);
    return true;
  });
  return dedupeRerunHashes(route, filtered);
}

export function buildRerunRoutePayload(route, selectedHashes, filter, label) {
  const safeMetadata = { ...(route?.metadata || {}) };
  delete safeMetadata.route_bounds;
  const uniqueHashes = dedupeRerunHashes(route, selectedHashes);
  return {
    name: `${route?.name || 'Completed Route'} Rerun — ${label}`,
    description: `Rerun from completed route: ${route?.name || route?.id}`,
    route_mode: route?.route_mode || 'precision',
    status: 'ACTIVE',
    assigned_to: route?.assigned_to || null,
    assigned_to_name: route?.assigned_to_name || null,
    priority: 0,
    property_hashes: uniqueHashes,
    metrics: {
      ...(route?.metrics || {}),
      distance: 0,
      house_count: uniqueHashes.length
    },
    start_location: null,
    route_origin_mode: 'none',
    manager_id: route?.manager_id || null,
    metadata: {
      ...safeMetadata,
      rerun_from_route_id: route?.id,
      rerun_filter: filter,
      rerun_created_at: new Date().toISOString()
    }
  };
}

export function getCompletedPinColor(status, fallbackColor) {
  if (status === 'SOLD' || status === 'QUALIFIED') return '#2EEB57';
  if (status === 'CALLBACK') return '#3b82f6';
  if (status === 'NO_ANSWER' || status === 'NOT_MOVED_IN' || status === 'DM_NOT_HOME') return '#9CA3AF';
  if (status === 'HARD_NO' || status === 'DO_NOT_KNOCK') return '#ef4444';
  return fallbackColor;
}