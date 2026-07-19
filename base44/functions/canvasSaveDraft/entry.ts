import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_POLYGON_POINTS = 800;
const MAX_AREA_SQ_MI = 1_000;
const MAX_ZONES = 250;
const MAX_WORK_UNITS = 20000;
const MAX_SEGMENTS = 50000;
const MAX_JSON_BYTES = 8_000_000;
const MAX_CANVAS_INTERACTIVE_WORK_UNITS = 20_000;
const MAX_CANVAS_INTERACTIVE_COMPLEXITY = 2_000_000;
const PLANNING_METHODS = new Set(['street_workload', 'preview_only']);
const ASSIGNMENT_BASES = new Set(['street_work_unit_ids', 'legacy_geometry']);
const WORKLOAD_BASES = new Set(['street_length', 'street_length_plus_estimated_doors', 'residential_opportunity']);
const DIVISION_MODES = new Set(['selected_reps', 'area_count', 'street_workload_target']);
const TERRITORY_MODELS = new Set(['street_territory_v1', 'residential_street_territory_v2']);
const CANVAS_ROLES = new Set(['knock', 'transit_only', 'excluded', 'uncertain']);
const OPPORTUNITY_CLASSIFICATIONS = new Set(['likely', 'none', 'uncertain']);
const ACCESS_CLASSIFICATIONS = new Set(['permitted', 'restricted', 'uncertain']);
const GROUP_OVERRIDE_ROLES = new Set(['transit_only', 'excluded']);
const MAX_GROUP_OVERRIDE_UNITS = 250;

class HttpError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, message: string, details: any = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function isoInstant(value: unknown) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function betaGrantResolution(user: any) {
  const userId = String(user?.id || '');
  if (!userId) return { present: false, grant: null };
  const encoded = Deno.env.get('BETA_ACCESS_GRANTS');
  if (!encoded) return { present: false, grant: null };
  let document: any;
  try {
    document = JSON.parse(encoded);
  } catch {
    return { present: false, grant: null };
  }
  if (!document || Array.isArray(document) || document.version !== 1
    || !document.grants || Array.isArray(document.grants) || typeof document.grants !== 'object') {
    return { present: false, grant: null };
  }
  if (!Object.prototype.hasOwnProperty.call(document.grants, userId)) return { present: false, grant: null };
  const candidate = document.grants[userId];
  const startsAt = isoInstant(candidate?.starts_at);
  const endsAt = isoInstant(candidate?.ends_at);
  const precisionLimit = Number(candidate?.precision_limit);
  const canvasSeats = Number(candidate?.canvas_seats);
  if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object'
    || typeof candidate.grant_id !== 'string' || !candidate.grant_id.trim() || candidate.grant_id.length > 256
    || candidate.status !== 'active'
    || !Number.isInteger(precisionLimit) || precisionLimit < 1 || precisionLimit > 1_000
    || !Number.isInteger(canvasSeats) || canvasSeats < 1 || canvasSeats > 100
    || startsAt === null || endsAt === null || startsAt >= endsAt) {
    return { present: true, grant: null };
  }
  const now = Date.now();
  if (now < startsAt || now >= endsAt) return { present: true, grant: null };
  return {
    present: true,
    grant: {
      grant_id: candidate.grant_id,
      precision_limit: precisionLimit,
      canvas_seats: canvasSeats,
      starts_at: candidate.starts_at,
      ends_at: candidate.ends_at
    }
  };
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function hasDraftCanvasEntitlement(user: any) {
  const accountRole = normalized(user?.role || user?.data?.role);
  if (accountRole === 'admin') return true;
  const beta = betaGrantResolution(user);
  if (beta.present) return Boolean(beta.grant);
  if (normalized(user?.subscription_tier) !== 'canvas') return false;
  const status = normalized(user?.subscription_status);
  if (status === 'active') return user?.subscription_paid_confirmed === true;
  return status === 'trialing' && user?.stripe_card_on_file_confirmed === true;
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_plan', `${field} is required or invalid.`);
  return result;
}

function optionalString(value: unknown, maxLength = 512) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value).trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_plan', 'A Canvas plan identifier is invalid.');
  return result;
}

function normalizePoint(point: any, field: string) {
  const lat = Number(point?.lat ?? point?.[0]);
  const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, 'invalid_plan', `${field} contains an invalid coordinate.`);
  }
  return { lat, lng };
}

function samePoint(left: any, right: any) {
  return Math.abs(left.lat - right.lat) < 0.0000001 && Math.abs(left.lng - right.lng) < 0.0000001;
}

function polygonAreaSqMi(points: any[]) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({ x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

function normalizePolygon(input: any, field = 'polygon', maxPoints = MAX_POLYGON_POINTS) {
  if (!Array.isArray(input) || input.length < 3 || input.length > maxPoints) {
    throw new HttpError(400, 'invalid_polygon', `${field} must contain 3-${maxPoints} points.`);
  }
  const points = input.map((point, index) => normalizePoint(point, `${field}[${index}]`));
  if (points.length > 3 && samePoint(points[0], points[points.length - 1])) points.pop();
  if (new Set(points.map((point) => `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`)).size < 3) {
    throw new HttpError(400, 'invalid_polygon', `${field} needs at least three unique points.`);
  }
  return points;
}

function normalizeIdList(value: any, field: string, maxItems = MAX_WORK_UNITS) {
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, 'invalid_plan', `${field} must be an array with at most ${maxItems} items.`);
  const ids = value.map((item, index) => requiredString(item, `${field}[${index}]`, 512));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate_reference', `${field} contains a duplicate identifier.`);
  return ids;
}

function sameIdSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => new Set(right).has(id));
}

function finiteNumber(value: any, field: string, minimum = 0, nullable = false) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) throw new HttpError(400, 'invalid_plan', `${field} must be a number of at least ${minimum}.`);
  return result;
}

function normalizeSegments(value: any, field: string) {
  if (!Array.isArray(value) || value.length < 1) throw new HttpError(400, 'invalid_plan', `${field} must contain road segments.`);
  return value.map((segment, index) => ({
    edge_id: optionalString(segment?.edge_id ?? segment?.edgeId, 512),
    start: normalizePoint(segment?.start, `${field}[${index}].start`),
    end: normalizePoint(segment?.end, `${field}[${index}].end`),
    street_names: normalizeIdList(segment?.street_names ?? segment?.streetNames ?? [], `${field}[${index}].street_names`, 25),
    length_meters: finiteNumber(segment?.length_meters ?? segment?.lengthMeters, `${field}[${index}].length_meters`)
  }));
}

function normalizeWorkUnits(input: any) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_WORK_UNITS) {
    throw new HttpError(400, 'invalid_plan', `work_units must contain 1-${MAX_WORK_UNITS} records.`);
  }
  let segmentCount = 0;
  const ids = new Set<string>();
  const units = input.map((unit, index) => {
    const id = requiredString(unit?.id ?? unit?.work_unit_id, `work_units[${index}].id`, 512);
    if (ids.has(id)) throw new HttpError(400, 'duplicate_work_unit', `Work unit ${id} appears more than once.`);
    ids.add(id);
    const segments = normalizeSegments(unit?.segments, `work_units[${index}].segments`);
    segmentCount += segments.length;
    const canvasRole = optionalString(unit?.canvas_role, 64);
    const opportunityClassification = optionalString(unit?.opportunity_classification, 64);
    const accessClassification = optionalString(unit?.access_classification, 64);
    if (canvasRole && !CANVAS_ROLES.has(canvasRole)) throw new HttpError(400, 'invalid_plan', `work_units[${index}].canvas_role is invalid.`);
    if (opportunityClassification && !OPPORTUNITY_CLASSIFICATIONS.has(opportunityClassification)) throw new HttpError(400, 'invalid_plan', `work_units[${index}].opportunity_classification is invalid.`);
    if (accessClassification && !ACCESS_CLASSIFICATIONS.has(accessClassification)) throw new HttpError(400, 'invalid_plan', `work_units[${index}].access_classification is invalid.`);
    const opportunityLow = finiteNumber(unit?.opportunity_low, `work_units[${index}].opportunity_low`, 0, true);
    const opportunityExpected = finiteNumber(unit?.opportunity_expected, `work_units[${index}].opportunity_expected`, 0, true);
    const opportunityHigh = finiteNumber(unit?.opportunity_high, `work_units[${index}].opportunity_high`, 0, true);
    if ([opportunityLow, opportunityExpected, opportunityHigh].every((value) => value !== null)
      && !(Number(opportunityLow) <= Number(opportunityExpected) && Number(opportunityExpected) <= Number(opportunityHigh))) {
      throw new HttpError(400, 'invalid_plan', `work_units[${index}] opportunity range is invalid.`);
    }
    const protectedGroupId = optionalString(unit?.protected_group_id, 512);
    const protectedGroupIds = normalizeIdList(unit?.protected_group_ids ?? [], `work_units[${index}].protected_group_ids`, 100);
    if (protectedGroupId && protectedGroupIds.length && !protectedGroupIds.includes(protectedGroupId)) {
      throw new HttpError(400, 'invalid_plan', `work_units[${index}].protected_group_id must appear in protected_group_ids.`);
    }
    return {
      id,
      unit_id: id,
      kind: optionalString(unit?.kind, 128),
      canvas_role: canvasRole,
      opportunity_classification: opportunityClassification,
      access_classification: accessClassification,
      opportunity_low: opportunityLow,
      opportunity_expected: opportunityExpected,
      opportunity_high: opportunityHigh,
      opportunity_source: optionalString(unit?.opportunity_source, 256),
      confidence: optionalString(unit?.confidence, 128),
      protected: unit?.protected === true,
      protected_group_id: protectedGroupId,
      protected_group_ids: protectedGroupIds.length ? protectedGroupIds : protectedGroupId ? [protectedGroupId] : [],
      street_names: normalizeIdList(unit?.street_names ?? unit?.streetNames ?? [], `work_units[${index}].street_names`, 100),
      neighbor_ids: normalizeIdList(unit?.neighbor_ids ?? unit?.neighborIds ?? [], `work_units[${index}].neighbor_ids`, MAX_WORK_UNITS),
      street_length_meters: finiteNumber(unit?.street_length_meters ?? unit?.streetLengthMeters, `work_units[${index}].street_length_meters`),
      segments
    };
  });
  if (segmentCount > MAX_SEGMENTS) throw new HttpError(413, 'plan_too_large', `work_units may contain at most ${MAX_SEGMENTS} road segments.`);
  for (const unit of units) {
    const unknown = unit.neighbor_ids.filter((id) => !ids.has(id));
    if (unknown.length) throw new HttpError(400, 'invalid_work_unit_graph', `Work unit ${unit.id} references an unknown neighbor.`);
  }
  return units;
}

function normalizeZoneParts(zone: any, index: number) {
  const rawWorkUnitIds = zone?.work_unit_ids ?? zone?.street_work_unit_ids;
  const streetOwnedDisplay = zone?.geometry_role === 'display_only'
    && Array.isArray(rawWorkUnitIds)
    && rawWorkUnitIds.length > 0;
  const hasGeometry = Array.isArray(zone?.geometry) && zone.geometry.length >= 3;
  const hasParts = Array.isArray(zone?.parts) && zone.parts.some((part: any) => Array.isArray(part) && part.length >= 3);
  if (streetOwnedDisplay && !hasGeometry && !hasParts) return { geometry: [], parts: [] };
  const rawParts = Array.isArray(zone?.parts) && zone.parts.length ? zone.parts : [zone?.geometry];
  const parts = rawParts.map((part, partIndex) => normalizePolygon(part, `zones[${index}].parts[${partIndex}]`, 5000));
  const geometry = normalizePolygon(zone?.geometry || parts[0], `zones[${index}].geometry`, 5000);
  return { geometry, parts };
}

function normalizeZones(input: any) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_ZONES) {
    throw new HttpError(400, 'invalid_plan', `zones must contain 1-${MAX_ZONES} records.`);
  }
  const zoneIds = new Set<string>();
  const zoneNumbers = new Set<number>();
  return input.map((zone, index) => {
    const zoneId = requiredString(zone?.zone_id, `zones[${index}].zone_id`, 512);
    const zoneNumber = Number(zone?.zone_number ?? index + 1);
    if (!Number.isInteger(zoneNumber) || zoneNumber < 1 || zoneIds.has(zoneId) || zoneNumbers.has(zoneNumber)) {
      throw new HttpError(400, 'duplicate_zone', 'Every zone needs a unique ID and positive zone number.');
    }
    zoneIds.add(zoneId);
    zoneNumbers.add(zoneNumber);
    const { geometry, parts } = normalizeZoneParts(zone, index);
    const workUnitIds = normalizeIdList(zone?.work_unit_ids ?? zone?.street_work_unit_ids ?? [], `zones[${index}].work_unit_ids`);
    return {
      zone_id: zoneId,
      zone_number: zoneNumber,
      name: optionalString(zone?.name, 200) || `Area ${zoneNumber}`,
      color: optionalString(zone?.color, 64),
      geometry,
      parts,
      geometry_role: optionalString(zone?.geometry_role, 64) || 'display_only',
      center: zone?.center ? normalizePoint(zone.center, `zones[${index}].center`) : null,
      drop_point: zone?.drop_point ? normalizePoint(zone.drop_point, `zones[${index}].drop_point`) : null,
      assigned_team_member_id: optionalString(zone?.assigned_team_member_id, 256),
      work_unit_ids: workUnitIds,
      street_work_unit_ids: workUnitIds,
      street_length_meters: finiteNumber(zone?.street_length_meters ?? zone?.street_length_m, `zones[${index}].street_length_meters`),
      estimated_doors: finiteNumber(zone?.estimated_doors, `zones[${index}].estimated_doors`, 0, true),
      estimated_minutes: finiteNumber(zone?.estimated_minutes, `zones[${index}].estimated_minutes`, 0, true),
      workload_score: finiteNumber(zone?.workload_score ?? zone?.street_length_meters ?? zone?.street_length_m, `zones[${index}].workload_score`),
      workload_share: finiteNumber(zone?.workload_share, `zones[${index}].workload_share`, 0, true),
      protected_unit_over_target: zone?.protected_unit_over_target === true
    };
  });
}

function residentialKnockNeighborMap(workUnits: any[]) {
  const byId = new Map(workUnits.map((unit) => [String(unit?.id || ''), unit]).filter(([id]) => id));
  const base = new Map([...byId.keys()].map((id) => [id, new Set<string>()]));
  for (const [id, unit] of byId) {
    for (const rawNeighborId of asArray(unit?.neighbor_ids ?? unit?.neighborIds)) {
      const neighborId = String(rawNeighborId || '');
      if (!neighborId || !byId.has(neighborId) || neighborId === id) continue;
      base.get(id)?.add(neighborId);
      base.get(neighborId)?.add(id);
    }
  }

  const knockIds = new Set([...byId].filter(([, unit]) => unit?.canvas_role === 'knock').map(([id]) => id));
  const effective = new Map([...knockIds].map((id) => [id, new Set<string>()]));
  for (const id of knockIds) {
    for (const neighborId of base.get(id) || []) if (knockIds.has(neighborId)) effective.get(id)?.add(neighborId);
  }

  const transitIds = new Set([...byId].filter(([, unit]) => unit?.canvas_role === 'transit_only').map(([id]) => id));
  const unseen = new Set(transitIds);
  while (unseen.size) {
    const seed = [...unseen].sort()[0];
    const queue = [seed];
    const borderingKnockIds = new Set<string>();
    unseen.delete(seed);
    for (let index = 0; index < queue.length; index += 1) {
      for (const neighborId of base.get(queue[index]) || []) {
        if (transitIds.has(neighborId) && unseen.has(neighborId)) {
          unseen.delete(neighborId);
          queue.push(neighborId);
        } else if (knockIds.has(neighborId)) borderingKnockIds.add(neighborId);
      }
    }
    const borders = [...borderingKnockIds];
    for (const id of borders) for (const neighborId of borders) if (id !== neighborId) effective.get(id)?.add(neighborId);
  }
  return effective;
}

function residentialZonesConnected(workUnits: any[], zones: any[]) {
  const neighbors = residentialKnockNeighborMap(workUnits);
  return zones.length > 0 && zones.every((zone) => {
    const ids = asArray(zone?.work_unit_ids).map(String);
    if (!ids.length || ids.some((id) => !neighbors.has(id))) return false;
    const allowed = new Set(ids);
    const visited = new Set([ids[0]]);
    const queue = [ids[0]];
    for (let index = 0; index < queue.length; index += 1) {
      for (const neighborId of neighbors.get(queue[index]) || []) {
        if (!allowed.has(neighborId) || visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }
    return visited.size === allowed.size;
  });
}

function residentialProtectedGroupsIntact(workUnits: any[], zones: any[]) {
  const zoneByUnitId = new Map(zones.flatMap((zone) => asArray(zone?.work_unit_ids).map((id) => [String(id), String(zone?.zone_id || '')])));
  const zonesByGroupId = new Map<string, Set<string>>();
  for (const unit of workUnits.filter((candidate) => candidate?.canvas_role === 'knock')) {
    const groupIds = [...new Set([
      ...asArray(unit?.protected_group_ids),
      unit?.protected_group_id,
    ].map((id) => String(id || '').trim()).filter(Boolean))];
    for (const groupId of groupIds) {
      if (!zonesByGroupId.has(groupId)) zonesByGroupId.set(groupId, new Set());
      zonesByGroupId.get(groupId)?.add(zoneByUnitId.get(String(unit.id)) || '');
    }
  }
  return [...zonesByGroupId.values()].every((zoneIds) => zoneIds.size === 1 && !zoneIds.has(''));
}

function deriveQa(workUnits: any[], zones: any[], suppliedQa: any, territoryModel = 'street_territory_v1') {
  let clientQa: any = {};
  try {
    clientQa = JSON.parse(JSON.stringify(suppliedQa || {}));
  } catch {
    throw new HttpError(400, 'invalid_plan', 'qa must be valid JSON.');
  }
  const ownershipUnits = territoryModel === 'residential_street_territory_v2'
    ? workUnits.filter((unit) => unit.canvas_role === 'knock')
    : workUnits;
  const expectedIds = new Set(ownershipUnits.map((unit) => unit.id));
  const counts = new Map<string, number>();
  for (const zone of zones) for (const id of zone.work_unit_ids) counts.set(id, (counts.get(id) || 0) + 1);
  const missingIds = [...expectedIds].filter((id) => !counts.has(id));
  const duplicateIds = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  const extraIds = [...counts.keys()].filter((id) => !expectedIds.has(id));
  const protectedIds = new Set(ownershipUnits.filter((unit) => unit.protected).map((unit) => unit.id));
  const protectedUnitsIntact = [...protectedIds].every((id) => counts.get(id) === 1)
    && (territoryModel !== 'residential_street_territory_v2' || residentialProtectedGroupsIntact(workUnits, zones));
  const streetCoverageComplete = missingIds.length === 0 && extraIds.length === 0;
  const noDuplicateWorkUnits = duplicateIds.length === 0;
  const residentialV2 = territoryModel === 'residential_street_territory_v2';
  const connectedZones = residentialV2
    ? residentialZonesConnected(workUnits, zones)
    : clientQa.connected_zones === true;
  const atomicWorkUnits = residentialV2
    ? streetCoverageComplete && noDuplicateWorkUnits
    : clientQa.atomic_work_units === true && streetCoverageComplete && noDuplicateWorkUnits;
  const culDeSacSplits = residentialV2
    ? protectedUnitsIntact && streetCoverageComplete && noDuplicateWorkUnits ? 0 : 1
    : Math.max(0, Number(clientQa.cul_de_sac_splits) || 0);
  const workloadScores = zones.map((zone) => Number(zone.workload_score));
  const averageWorkload = workloadScores.length
    && workloadScores.every((score) => Number.isFinite(score) && score >= 0)
    ? workloadScores.reduce((sum, score) => sum + score, 0) / workloadScores.length
    : 0;
  const maxWorkloadDeviationPercent = averageWorkload > 0
    ? Math.round(Math.max(...workloadScores.map((score) => Math.abs(score - averageWorkload) / averageWorkload)) * 100)
    : null;
  return {
    ...clientQa,
    territory_source: 'street_work_units',
    street_coverage_complete: streetCoverageComplete,
    no_duplicate_work_units: noDuplicateWorkUnits,
    no_missing_work_units: missingIds.length === 0,
    connected_zones: connectedZones,
    atomic_work_units: atomicWorkUnits,
    protected_units_intact: protectedUnitsIntact && (residentialV2 || clientQa.protected_units_intact === true),
    cul_de_sac_splits: culDeSacSplits,
    missing_work_unit_ids: missingIds.slice(0, 100),
    duplicate_work_unit_ids: duplicateIds.slice(0, 100),
    extra_work_unit_ids: extraIds.slice(0, 100),
    work_unit_count: workUnits.length,
    zone_count: zones.length,
    total_street_length_meters: Number(workUnits.reduce((sum, unit) => sum + unit.street_length_meters, 0).toFixed(2)),
    total_residential_opportunity: Number(ownershipUnits.reduce((sum, unit) => sum + Number(unit.opportunity_expected || 0), 0).toFixed(2)),
    max_workload_deviation_percent: maxWorkloadDeviationPercent,
    deployable: streetCoverageComplete
      && noDuplicateWorkUnits
      && connectedZones
      && atomicWorkUnits
      && protectedUnitsIntact
      && (residentialV2 || clientQa.protected_units_intact === true)
      && culDeSacSplits === 0
      && zones.length > 0
  };
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const data = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function asArray(value: any) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function snapshotContent(snapshot: any) {
  return {
    schema_version: Number(snapshot?.schema_version),
    manager_id: snapshot?.manager_id,
    provider: snapshot?.provider,
    source_version: snapshot?.source_version,
    extraction_version: snapshot?.extraction_version,
    classifier_version: snapshot?.classifier_version,
    polygon: asArray(snapshot?.polygon),
    raw_evidence: snapshot?.raw_evidence || {},
    analysis_result: snapshot?.analysis_result || {},
    source_attribution: snapshot?.source_attribution || '© OpenStreetMap contributors'
  };
}

function evidenceTrust(snapshot: any) {
  const provider = String(snapshot?.provider || '');
  if (provider === 'openstreetmap-contracted-or-self-hosted') return 'trusted';
  if (provider === 'openstreetmap-public-development-fallback') return 'development_fallback';
  return 'untrusted';
}

function canonicalRevisionTargetIds(revision: any) {
  const source = Number(revision?.schema_version) >= 2 ? asArray(revision?.street_unit_ids) : [revision?.street_unit_id];
  return [...new Set(source.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function canonicalOriginalClassifications(revision: any) {
  return asArray(revision?.original_classifications).map((entry) => ({
    street_unit_id: String(entry?.street_unit_id || '').trim(),
    opportunity_classification: entry?.opportunity_classification || null,
    access_classification: entry?.access_classification || null,
    canvas_role: entry?.canvas_role || null
  })).filter((entry) => entry.street_unit_id).sort((left, right) => left.street_unit_id === right.street_unit_id ? 0 : left.street_unit_id < right.street_unit_id ? -1 : 1);
}

function revisionContent(revision: any) {
  const content: any = {
    schema_version: Number(revision?.schema_version), manager_id: revision?.manager_id, evidence_id: revision?.evidence_id,
    parent_revision_id: revision?.parent_revision_id || null, street_unit_id: revision?.street_unit_id,
    original_opportunity_classification: revision?.original_opportunity_classification || null,
    original_access_classification: revision?.original_access_classification || null,
    override_opportunity_classification: revision?.override_opportunity_classification || null,
    override_access_classification: revision?.override_access_classification || null, override_canvas_role: revision?.override_canvas_role,
    opportunity_low: Number(revision?.opportunity_low || 0), opportunity_expected: Number(revision?.opportunity_expected || 0), opportunity_high: Number(revision?.opportunity_high || 0),
    opportunity_source: revision?.opportunity_source || null, confidence: revision?.confidence || null,
    override_reason: revision?.override_reason, created_by_user_id: revision?.created_by_user_id
  };
  if (Number(revision?.schema_version) >= 2) {
    content.street_unit_ids = canonicalRevisionTargetIds(revision);
    content.original_classifications = canonicalOriginalClassifications(revision);
  }
  return content;
}

function revisionTargetUnitIds(revision: any) {
  const ids = canonicalRevisionTargetIds(revision);
  if (Number(revision?.schema_version) < 2) {
    if (ids.length !== 1 || ids[0] !== String(revision?.street_unit_id || '')) throw new HttpError(409, 'revision_targets_invalid', 'A single-unit classification revision has an invalid target.');
    return ids;
  }
  const originals = canonicalOriginalClassifications(revision);
  if (ids.length < 2 || ids.length > MAX_GROUP_OVERRIDE_UNITS || revision?.street_unit_id !== ids[0]
    || !GROUP_OVERRIDE_ROLES.has(String(revision?.override_canvas_role || ''))
    || originals.length !== ids.length
    || originals.some((entry, index) => entry.street_unit_id !== ids[index])) {
    throw new HttpError(409, 'revision_targets_invalid', 'An atomic classification group revision has invalid targets or audit metadata.');
  }
  return ids;
}

async function loadResidentialEvidence(base44: any, managerId: string, evidenceId: string, snapshotHash: string, revisionId: string | null) {
  const snapshots = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: managerId }, null, 2, 0));
  if (snapshots.length !== 1 || snapshots[0].manager_id !== managerId || snapshots[0].status !== 'complete') {
    throw new HttpError(404, 'analysis_not_found', 'The Canvas evidence snapshot was not found in this manager tenant.');
  }
  const snapshot = snapshots[0];
  const calculatedSnapshotHash = await sha256(snapshotContent(snapshot));
  if (calculatedSnapshotHash !== snapshot.snapshot_hash || snapshotHash !== snapshot.snapshot_hash || evidenceId !== `canvas_evidence_${calculatedSnapshotHash}`) {
    throw new HttpError(409, 'evidence_integrity_failed', 'The Canvas evidence identity or canonical content hash is invalid.');
  }
  const revisions = [];
  const seen = new Set<string>();
  let cursor = revisionId;
  while (cursor) {
    if (seen.has(cursor) || revisions.length >= 500) throw new HttpError(409, 'revision_chain_invalid', 'The classification revision chain is cyclic or exceeds its safe limit.');
    seen.add(cursor);
    const rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({ revision_id: cursor, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
    if (rows.length !== 1) throw new HttpError(404, 'revision_not_found', 'A pinned classification revision was not found in this manager tenant.');
    const revision = rows[0];
    const calculatedRevisionHash = await sha256(revisionContent(revision));
    if (revision.revision_hash !== calculatedRevisionHash || revision.revision_id !== `canvas_revision_${calculatedRevisionHash}`) throw new HttpError(409, 'revision_integrity_failed', 'A pinned classification revision failed canonical content verification.');
    revisionTargetUnitIds(revision);
    revisions.push(revision);
    cursor = revision.parent_revision_id ? String(revision.parent_revision_id) : null;
  }
  const effectiveUnits = asArray(snapshot?.analysis_result?.street_units).map((unit: any) => ({ ...unit }));
  const byId = new Map(effectiveUnits.map((unit: any) => [String(unit?.unit_id || unit?.id || ''), unit]));
  for (const revision of revisions.reverse()) {
    for (const streetUnitId of revisionTargetUnitIds(revision)) {
      const unit: any = byId.get(streetUnitId);
      if (!unit) throw new HttpError(409, 'revision_unit_missing', 'A classification revision references a street unit outside its evidence snapshot.');
      unit.opportunity_classification = revision.override_opportunity_classification || unit.opportunity_classification;
      unit.access_classification = revision.override_access_classification || unit.access_classification;
      unit.canvas_role = revision.override_canvas_role;
      unit.opportunity_low = Number(revision.opportunity_low || 0);
      unit.opportunity_expected = Number(revision.opportunity_expected || 0);
      unit.opportunity_high = Number(revision.opportunity_high || 0);
      unit.opportunity_source = revision.opportunity_source || unit.opportunity_source;
      unit.confidence = revision.confidence || unit.confidence;
    }
  }
  return { snapshot, effectiveUnits };
}

function canonicalResidentialUnit(unit: any) {
  return {
    id: String(unit?.unit_id || unit?.id || ''),
    kind: unit?.kind || null,
    canvas_role: unit?.canvas_role,
    opportunity_classification: unit?.opportunity_classification,
    access_classification: unit?.access_classification,
    opportunity_low: Number(unit?.opportunity_low || 0),
    opportunity_expected: Number(unit?.opportunity_expected || 0),
    opportunity_high: Number(unit?.opportunity_high || 0),
    opportunity_source: unit?.opportunity_source || null,
    confidence: unit?.confidence || null,
    protected: unit?.protected === true,
    protected_group_id: unit?.protected_group_id || null,
    protected_group_ids: asArray(unit?.protected_group_ids).map(String).sort(),
    street_names: asArray(unit?.street_names).map(String).sort(),
    neighbor_ids: asArray(unit?.neighbor_ids).map(String).sort(),
    segments: asArray(unit?.segments).map((segment: any) => ({
      edge_id: segment?.edge_id || null,
      start: { lat: Number(segment?.start?.lat), lng: Number(segment?.start?.lng) },
      end: { lat: Number(segment?.end?.lat), lng: Number(segment?.end?.lng) },
      street_names: asArray(segment?.street_names).map(String).sort(),
      length_meters: Number(segment?.length_meters || 0)
    }))
  };
}

function assertResidentialUnitsMatchEvidence(workUnits: any[], evidenceUnits: any[]) {
  const expectedById = new Map(evidenceUnits.map((unit) => [String(unit?.unit_id || unit?.id || ''), unit]));
  if (expectedById.size !== workUnits.length) throw new HttpError(409, 'evidence_plan_mismatch', 'The saved street-unit set does not match the pinned evidence snapshot.');
  for (const unit of workUnits) {
    const expected: any = expectedById.get(unit.id);
    if (!expected || JSON.stringify(canonicalize(canonicalResidentialUnit(unit))) !== JSON.stringify(canonicalize(canonicalResidentialUnit(expected)))) {
      throw new HttpError(409, 'evidence_plan_mismatch', `Street unit ${unit.id} does not match the pinned evidence/revision classification.`);
    }
  }
}

async function validateManagerAssignments(base44: any, managerId: string, memberIds: string[]) {
  const requested = [...new Set(memberIds.map(String))];
  if (!requested.length) return;
  const rows = [];
  for (let index = 0; index < requested.length; index += 100) {
    const ids = requested.slice(index, index + 100);
    rows.push(...asArray(await base44.asServiceRole.entities.TeamMember.filter({ manager_id: managerId, id: { $in: ids } }, null, ids.length, 0)));
  }
  const byId = new Map(rows.map((member: any) => [String(member?.id || ''), member]));
  if (byId.size !== requested.length || rows.length !== requested.length) throw new HttpError(422, 'invalid_team_assignment', 'One or more assigned reps are outside this manager tenant.');
  for (const id of requested) {
    const member: any = byId.get(id);
    if (!member || member.manager_id !== managerId || member.status !== 'active' || normalized(member.role) !== 'rep' || !String(member.user_id || '').trim()) {
      throw new HttpError(422, 'invalid_team_assignment', `Team member ${id} is not an active linked rep owned by this manager.`);
    }
  }
  const userIds = requested.map((id) => String((byId.get(id) as any).user_id));
  if (new Set(userIds).size !== userIds.length) throw new HttpError(422, 'unverified_team_link', 'Each Canvas rep must map to a distinct authenticated user.');
  const users = [];
  for (let index = 0; index < userIds.length; index += 100) {
    const ids = userIds.slice(index, index + 100);
    users.push(...asArray(await base44.asServiceRole.entities.User.filter({ team_manager_id: managerId, id: { $in: ids } }, null, ids.length, 0)));
  }
  const usersById = new Map(users.map((repUser: any) => [String(repUser?.id || ''), repUser]));
  for (const id of requested) {
    const member: any = byId.get(id);
    const repUser: any = usersById.get(String(member.user_id));
    if (!repUser || repUser.team_manager_id !== managerId || normalized(repUser.email) !== normalized(member.email)) throw new HttpError(422, 'unverified_team_link', `Team member ${id} is not linked to an authenticated user in this manager tenant.`);
  }
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'Only managers can save Canvas drafts.' }, { status: 403 });
    if (!hasDraftCanvasEntitlement(user)) {
      return Response.json({ error: 'canvas_entitlement_required', message: 'An active or card-backed trial Canvas plan is required.' }, { status: 403 });
    }

    const declaredBodyBytes = Number(req.headers.get('content-length'));
    if (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > MAX_JSON_BYTES) {
      throw new HttpError(413, 'plan_too_large', 'Canvas draft payload is too large.');
    }
    const body = await req.json().catch(() => ({}));
    const normalizedBodyBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (normalizedBodyBytes > MAX_JSON_BYTES) throw new HttpError(413, 'plan_too_large', 'Canvas draft payload is too large.');

    const sessionId = optionalString(body?.session_id, 256);
    let existing = null;
    let version = 1;
    if (sessionId) {
      existing = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
      if (!existing) throw new HttpError(404, 'session_not_found', 'Canvas session not found.');
      if (String(existing.manager_id || '') !== String(user.id || '')) throw new HttpError(403, 'forbidden', 'This Canvas session belongs to another manager.');
      if (existing.status !== 'draft') throw new HttpError(409, 'campaign_immutable', 'Active or closed Canvas campaigns are immutable. Create a new draft to rebalance.');
      const expectedVersion = Number(body?.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version || 1)) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed. Reload it before saving again.');
      }
      version = expectedVersion + 1;
    }

    const territoryModel = optionalString(body?.territory_model, 128) || existing?.territory_model || 'street_territory_v1';
    if (!TERRITORY_MODELS.has(territoryModel)) throw new HttpError(400, 'invalid_plan', 'Unsupported Canvas territory model.');
    if (existing && existing.territory_model !== territoryModel) throw new HttpError(409, 'territory_model_immutable', 'A saved Canvas draft cannot change territory model. Create a new draft.');

    const rawPlanningMethod = requiredString(body?.planning_method, 'planning_method', 64);
    const planningMethod = rawPlanningMethod === 'street_work_units' ? 'street_workload' : rawPlanningMethod;
    const assignmentBasis = requiredString(body?.assignment_basis, 'assignment_basis', 64);
    const legacySizingMode = body?.workload_basis === 'selected_reps' || body?.workload_basis === 'homes_per_area'
      ? body.workload_basis
      : null;
    const requestedDivisionMode = body?.division_mode === 'workload_size' ? 'street_workload_target' : body?.division_mode;
    const divisionMode = requiredString(requestedDivisionMode || (legacySizingMode === 'homes_per_area' ? 'area_count' : 'selected_reps'), 'division_mode', 64);
    const defaultWorkloadBasis = territoryModel === 'residential_street_territory_v2' ? 'residential_opportunity' : 'street_length';
    const rawWorkloadBasis = legacySizingMode ? 'street_length' : requiredString(body?.workload_basis || defaultWorkloadBasis, 'workload_basis', 64);
    const workloadBasis = rawWorkloadBasis === 'estimated_doors' ? 'street_length_plus_estimated_doors' : rawWorkloadBasis;
    if (!PLANNING_METHODS.has(planningMethod) || !ASSIGNMENT_BASES.has(assignmentBasis)
      || !WORKLOAD_BASES.has(workloadBasis) || !DIVISION_MODES.has(divisionMode)) {
      throw new HttpError(400, 'invalid_plan', 'Unsupported Canvas planning method, assignment basis, division mode, or workload basis.');
    }

    const polygon = normalizePolygon(body?.polygon);
    const areaSqMi = polygonAreaSqMi(polygon);
    if (!Number.isFinite(areaSqMi) || areaSqMi <= 0 || areaSqMi > MAX_AREA_SQ_MI) {
      throw new HttpError(400, 'invalid_polygon', `polygon area must be greater than zero and at most ${MAX_AREA_SQ_MI} square miles.`);
    }
    const workUnits = normalizeWorkUnits(body?.work_units);
    let zones = normalizeZones(body?.zones);
    if (workUnits.length > MAX_CANVAS_INTERACTIVE_WORK_UNITS || zones.length * workUnits.length > MAX_CANVAS_INTERACTIVE_COMPLEXITY) {
      throw new HttpError(413, 'plan_too_complex', 'This street plan exceeds the supported street-unit or area-by-unit limit. Reduce the boundary or area count that exceeded its limit.');
    }
    let evidenceId: string | null = null;
    let revisionId: string | null = null;
    let snapshotHash: string | null = null;
    let evidenceSchemaVersion: number | null = null;
    let evidenceAlgorithmVersion: string | null = null;
    let evidenceDataVersion: string | null = null;
    let residentialEvidenceTrust: 'trusted' | 'development_fallback' | 'untrusted' | null = null;
    if (territoryModel === 'residential_street_territory_v2') {
      if (planningMethod !== 'street_workload' || assignmentBasis !== 'street_work_unit_ids' || workloadBasis !== 'residential_opportunity') {
        throw new HttpError(422, 'invalid_residential_plan', 'Residential Canvas v2 requires street_workload, street_work_unit_ids, and residential_opportunity.');
      }
      evidenceId = requiredString(body?.evidence_id, 'evidence_id', 256);
      snapshotHash = requiredString(body?.snapshot_hash, 'snapshot_hash', 128);
      if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new HttpError(400, 'invalid_plan', 'snapshot_hash must be a lowercase SHA-256 digest.');
      revisionId = optionalString(body?.revision_id, 256);
      if (existing && existing.evidence_id && existing.evidence_id !== evidenceId) throw new HttpError(409, 'evidence_identity_immutable', 'A saved Canvas draft cannot be rebound to different raw evidence. Create a new draft.');
      const verifiedEvidence = await loadResidentialEvidence(base44, String(user.id), evidenceId, snapshotHash, revisionId);
      evidenceSchemaVersion = Number(verifiedEvidence.snapshot.schema_version);
      evidenceAlgorithmVersion = String(verifiedEvidence.snapshot.classifier_version || '');
      evidenceDataVersion = String(verifiedEvidence.snapshot.source_version || '');
      residentialEvidenceTrust = evidenceTrust(verifiedEvidence.snapshot);
      if (JSON.stringify(canonicalize(verifiedEvidence.snapshot.polygon)) !== JSON.stringify(canonicalize(polygon))) throw new HttpError(409, 'evidence_polygon_mismatch', 'The saved boundary does not match the immutable evidence snapshot.');
      assertResidentialUnitsMatchEvidence(workUnits, verifiedEvidence.effectiveUnits);
      const unitById = new Map(workUnits.map((unit) => [unit.id, unit]));
      zones = zones.map((zone) => {
        const assignedUnits = zone.work_unit_ids.map((id) => unitById.get(id));
        if (assignedUnits.some((unit) => !unit || unit.canvas_role !== 'knock')) throw new HttpError(422, 'invalid_street_ownership', `Zone ${zone.zone_id} may own only knock street units.`);
        const opportunity = assignedUnits.reduce((sum, unit: any) => sum + Number(unit.opportunity_expected || 0), 0);
        return { ...zone, estimated_doors: opportunity, workload_score: opportunity };
      });
    }

    const zoneAssigneeIds = zones.map((zone) => zone.assigned_team_member_id).filter(Boolean);
    const uniqueAssigneeIds = [...new Set(zoneAssigneeIds)];
    const suppliedTeamMemberIds = normalizeIdList(body?.selected_team_member_ids || [], 'selected_team_member_ids', MAX_ZONES);
    const selectedTeamMemberIds = territoryModel === 'residential_street_territory_v2'
      ? uniqueAssigneeIds
      : suppliedTeamMemberIds.length ? suppliedTeamMemberIds : uniqueAssigneeIds;
    if (territoryModel === 'residential_street_territory_v2') await validateManagerAssignments(base44, String(user.id), uniqueAssigneeIds);
    const everyZoneAssigned = zoneAssigneeIds.length === zones.length;
    const selectionMatches = everyZoneAssigned && sameIdSet(selectedTeamMemberIds, uniqueAssigneeIds);
    const oneToOneRequired = divisionMode === 'selected_reps';
    const selectedRepsOneToOne = oneToOneRequired
      ? zones.length === selectedTeamMemberIds.length && uniqueAssigneeIds.length === zones.length && selectionMatches
      : null;
    const assignmentContractSatisfied = oneToOneRequired ? selectedRepsOneToOne === true : selectionMatches;
    const suppliedTargetWorkload = finiteNumber(body?.target_workload, 'target_workload', 0, true);
    if (divisionMode === 'street_workload_target' && !(Number(suppliedTargetWorkload) > 0)) {
      throw new HttpError(400, 'invalid_plan', 'target_workload must be positive class-weighted street meters for street_workload_target planning.');
    }
    const targetWorkload = divisionMode === 'street_workload_target' ? suppliedTargetWorkload : null;
    const now = new Date().toISOString();
    const qa = {
      ...deriveQa(workUnits, zones, body?.qa, territoryModel),
      every_zone_assigned: everyZoneAssigned,
      selected_reps_one_to_one: selectedRepsOneToOne,
    };
    const workloadExceptionRequired = qa.max_workload_deviation_percent === null
      || Number(qa.max_workload_deviation_percent) > 25;
    const managerWorkloadExceptionAcknowledged = Number(qa.max_workload_deviation_percent) > 25
      && body?.qa?.manager_workload_exception_acknowledged === true;
    qa.manager_workload_exception_acknowledged = managerWorkloadExceptionAcknowledged;
    qa.manager_workload_exception_deviation_percent = qa.max_workload_deviation_percent;
    qa.manager_workload_exception_acknowledged_at = managerWorkloadExceptionAcknowledged ? now : null;
    qa.manager_workload_exception_acknowledged_by_user_id = managerWorkloadExceptionAcknowledged ? user.id : null;
    const unresolvedUnitCount = territoryModel === 'residential_street_territory_v2'
      ? workUnits.filter((unit) => unit.canvas_role === 'uncertain').length
      : 0;
    qa.unresolved_unit_count = unresolvedUnitCount;
    qa.evidence_trust = territoryModel === 'residential_street_territory_v2' ? residentialEvidenceTrust : null;
    qa.trusted_evidence = territoryModel === 'residential_street_territory_v2' ? residentialEvidenceTrust === 'trusted' : null;
    qa.deployable = qa.deployable
      && planningMethod === 'street_workload'
      && assignmentBasis === 'street_work_unit_ids'
      && workloadBasis === (territoryModel === 'residential_street_territory_v2' ? 'residential_opportunity' : 'street_length')
      && everyZoneAssigned
      && selectionMatches
      && assignmentContractSatisfied
      && unresolvedUnitCount === 0
      && (territoryModel !== 'residential_street_territory_v2' || residentialEvidenceTrust === 'trusted')
      && (!workloadExceptionRequired || managerWorkloadExceptionAcknowledged);
    const draftLifecycleState = territoryModel === 'residential_street_territory_v2'
      ? uniqueAssigneeIds.length === 0
        ? 'saved_unassigned'
        : everyZoneAssigned && unresolvedUnitCount === 0 && qa.deployable === true
          ? 'ready_to_send'
          : 'partially_assigned'
      : null;

    const normalizedPlan = {
      session_name: optionalString(body?.session_name, 200) || 'Canvas Campaign',
      territory_model: territoryModel,
      polygon,
      rep_count: uniqueAssigneeIds.length,
      planning_method: planningMethod,
      assignment_basis: assignmentBasis,
      workload_basis: workloadBasis,
      division_mode: divisionMode,
      target_workload: targetWorkload,
      selected_team_member_ids: selectedTeamMemberIds,
      zones,
      work_units: workUnits,
      qa,
      algorithm_version: optionalString(body?.algorithm_version, 128) || evidenceAlgorithmVersion,
      data_version: optionalString(body?.data_version, 256) || evidenceDataVersion,
      manager_id: user.id,
      version,
      ...(territoryModel === 'residential_street_territory_v2' ? {
        evidence_id: evidenceId,
        revision_id: revisionId,
        snapshot_hash: snapshotHash,
        evidence_schema_version: evidenceSchemaVersion,
        unresolved_unit_count: unresolvedUnitCount,
        assignment_version: Number(existing?.assignment_version || 0)
      } : {})
    };
    const planHash = await sha256(normalizedPlan);
    const record = {
      ...normalizedPlan,
      plan_hash: planHash,
      status: 'draft',
      draft_saved_at: now,
      deployed_at: null,
      deployed_by_user_id: null,
      deployment_idempotency_key: null,
      deployment_signature: null,
      deployment_qa: null,
      deployment_plan_version: null,
      lifecycle_state: draftLifecycleState,
      lifecycle_evidence: null,
      closed_at: null,
      closed_by_user_id: null,
      close_action: null,
      close_idempotency_key: null
    };

    let saved;
    if (existing) {
      const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
        id: existing.id,
        manager_id: user.id,
        status: 'draft',
        version: Number(body.expected_version),
        plan_hash: existing.plan_hash
      }, { $set: record });
      if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed. Reload it before saving again.');
      }
      saved = await base44.entities.CanvasSession.get(existing.id).catch(() => null);
      if (!saved || saved.manager_id !== user.id || saved.plan_hash !== planHash || Number(saved.version) !== version) {
        throw new HttpError(503, 'canvas_draft_commit_unverified', 'The Canvas draft update could not be confirmed. Reload before retrying.');
      }
    } else {
      saved = await base44.asServiceRole.entities.CanvasSession.create(record);
    }

    return Response.json({
      success: true,
      session_id: saved.id,
      version,
      status: 'draft',
      lifecycle_state: draftLifecycleState,
      plan_hash: planHash,
      area_sq_mi: Number(areaSqMi.toFixed(3)),
      qa
    });
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    console.error('[canvasSaveDraft]', error?.message || error);
    return Response.json({ error: 'canvas_draft_save_failed', message: 'Canvas draft could not be saved.' }, { status: 500 });
  }
});
