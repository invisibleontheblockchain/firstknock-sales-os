import {
  createHash,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';

export const CANVAS_EVIDENCE_SCHEMA = Object.freeze({
  manifest: 'firstknock.canvas-evidence-manifest',
  tile: 'firstknock.canvas-evidence-tile',
  version: 1,
});

export const CANVAS_EVIDENCE_ROLES = Object.freeze([
  'opportunity',
  'transit',
  'uncertain',
  'excluded',
]);

export const DEFAULT_CANVAS_EVIDENCE_LIMITS = Object.freeze({
  max_tile_bytes: 5_500_000,
  max_work_units_per_tile: 5_000,
  max_work_units_per_sq_mi: 20_000,
  max_expected_opportunities_per_sq_mi: 100_000,
  max_neighbors_per_work_unit: 64,
  max_coordinates_per_work_unit: 2_048,
  max_protected_groups_per_tile: 2_000,
  max_properties_per_tile: 50_000,
  max_properties_per_sq_mi: 200_000,
  max_tiles_per_release: 250_000,
});

const ID_PATTERNS = Object.freeze({
  release: /^cer1_[a-f0-9]{64}$/,
  tile: /^cet1_[a-f0-9]{64}$/,
  workUnit: /^cewu1_[a-f0-9]{64}$/,
  protectedGroup: /^cepg1_[a-f0-9]{64}$/,
  property: /^cepr1_[a-f0-9]{64}$/,
});

export class CanvasEvidenceContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasEvidenceContractError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanvasEvidenceContractError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) fail('invalid_record', `${field} must be an object.`, { field });
  return value;
}

function requireString(value, field, { pattern, maxLength = 512 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > maxLength) {
    fail('invalid_string', `${field} must be a non-empty, trimmed string.`, { field });
  }
  if (pattern && !pattern.test(value)) fail('invalid_identifier', `${field} is not canonical.`, { field, value });
  return value;
}

function requireInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('invalid_integer', `${field} must be an integer from ${min} through ${max}.`, { field, value });
  }
  return value;
}

function requireFinite(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('invalid_number', `${field} must be a finite number from ${min} through ${max}.`, { field, value });
  }
  return value;
}

function requireIsoInstant(value, field) {
  requireString(value, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('invalid_instant', `${field} must be a canonical UTC ISO-8601 instant.`, { field, value });
  }
  return value;
}

function assertUnique(values, field) {
  if (new Set(values).size !== values.length) fail('duplicate_value', `${field} contains duplicates.`, { field });
}

function assertSorted(values, field) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) > 0) {
      fail('non_canonical_order', `${field} must use canonical lexical order.`, { field });
    }
  }
}

function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non_canonical_number', `${path} contains a non-finite number.`, { path });
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (!isRecord(value)) fail('non_canonical_value', `${path} contains an unsupported value.`, { path });

  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('undefined_value', `${path}.${key} is undefined.`, { path: `${path}.${key}` });
    result[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalTileAddress(address) {
  const candidate = requireRecord(address, 'tile_address');
  const scheme = requireString(candidate.scheme, 'tile_address.scheme', {
    pattern: /^[a-z][a-z0-9.-]{0,63}$/,
    maxLength: 64,
  }).toLowerCase();
  const schemeVersion = requireInteger(candidate.scheme_version, 'tile_address.scheme_version', { min: 1, max: 999 });
  const key = requireString(candidate.key, 'tile_address.key', {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/,
    maxLength: 160,
  });
  return { scheme, scheme_version: schemeVersion, key };
}

export function canonicalTileId(address) {
  return `cet1_${sha256Hex(canonicalStringify(canonicalTileAddress(address)))}`;
}

export function canonicalWorkUnitDescriptor(descriptor) {
  const candidate = requireRecord(descriptor, 'work_unit_descriptor');
  const sourceNamespace = requireString(candidate.source_namespace, 'work_unit_descriptor.source_namespace', {
    pattern: /^[a-z][a-z0-9._-]{0,63}$/,
    maxLength: 64,
  }).toLowerCase();
  const sourceFeatureId = requireString(candidate.source_feature_id, 'work_unit_descriptor.source_feature_id', {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/,
    maxLength: 256,
  });
  const segmentIndex = requireInteger(candidate.segment_index, 'work_unit_descriptor.segment_index', { max: 10_000_000 });
  const fromMillionths = requireInteger(candidate.from_millionths, 'work_unit_descriptor.from_millionths', { max: 999_999 });
  const toMillionths = requireInteger(candidate.to_millionths, 'work_unit_descriptor.to_millionths', { min: 1, max: 1_000_000 });
  if (fromMillionths >= toMillionths) {
    fail('invalid_work_unit_range', 'Work-unit fractions must be increasing.', { from_millionths: fromMillionths, to_millionths: toMillionths });
  }
  return {
    source_namespace: sourceNamespace,
    source_feature_id: sourceFeatureId,
    segment_index: segmentIndex,
    from_millionths: fromMillionths,
    to_millionths: toMillionths,
  };
}

export function canonicalWorkUnitId(descriptor) {
  return `cewu1_${sha256Hex(canonicalStringify(canonicalWorkUnitDescriptor(descriptor)))}`;
}

export function canonicalPropertyId(propertyKey) {
  const key = requireString(propertyKey, 'property_key', { maxLength: 256 });
  return `cepr1_${sha256Hex(canonicalStringify({ property_key: key }))}`;
}

export function canonicalProtectedGroupId(kind, memberWorkUnitIds) {
  requireString(kind, 'protected_group.kind', { pattern: /^[a-z][a-z0-9_]{0,63}$/, maxLength: 64 });
  if (!Array.isArray(memberWorkUnitIds) || memberWorkUnitIds.length === 0) {
    fail('empty_protected_group', 'A protected group must contain at least one work unit.');
  }
  const members = [...memberWorkUnitIds];
  members.forEach((id, index) => requireString(id, `member_work_unit_ids[${index}]`, { pattern: ID_PATTERNS.workUnit }));
  assertUnique(members, 'member_work_unit_ids');
  members.sort();
  return `cepg1_${sha256Hex(canonicalStringify({ kind, member_work_unit_ids: members }))}`;
}

export function canonicalReleaseId(releaseIdentity) {
  const candidate = requireRecord(releaseIdentity, 'release_identity');
  const datasetNamespace = requireString(candidate.dataset_namespace, 'release_identity.dataset_namespace', {
    pattern: /^[a-z][a-z0-9._-]{0,63}$/,
    maxLength: 64,
  }).toLowerCase();
  const datasetVersion = requireString(candidate.dataset_version, 'release_identity.dataset_version', { maxLength: 128 });
  const generatedAt = requireIsoInstant(candidate.generated_at, 'release_identity.generated_at');
  return `cer1_${sha256Hex(canonicalStringify({
    dataset_namespace: datasetNamespace,
    dataset_version: datasetVersion,
    generated_at: generatedAt,
  }))}`;
}

function validateBounds(bounds, field = 'coverage.bounds') {
  const candidate = requireRecord(bounds, field);
  requireFinite(candidate.min_lng, `${field}.min_lng`, { min: -180, max: 180 });
  requireFinite(candidate.max_lng, `${field}.max_lng`, { min: -180, max: 180 });
  requireFinite(candidate.min_lat, `${field}.min_lat`, { min: -90, max: 90 });
  requireFinite(candidate.max_lat, `${field}.max_lat`, { min: -90, max: 90 });
  if (candidate.min_lng >= candidate.max_lng || candidate.min_lat >= candidate.max_lat) {
    fail('invalid_bounds', `${field} must have increasing longitude and latitude bounds.`, { field });
  }
}

function validateProvenance(provenance, field) {
  if (!Array.isArray(provenance) || provenance.length === 0) {
    fail('missing_provenance', `${field} must contain at least one source record.`, { field });
  }
  const keys = [];
  for (const [index, source] of provenance.entries()) {
    const path = `${field}[${index}]`;
    requireRecord(source, path);
    requireString(source.source_id, `${path}.source_id`, { pattern: /^[a-z][a-z0-9._-]{0,127}$/, maxLength: 128 });
    requireString(source.dataset_version, `${path}.dataset_version`, { maxLength: 128 });
    requireString(source.feature_id, `${path}.feature_id`, { maxLength: 256 });
    requireIsoInstant(source.observed_at, `${path}.observed_at`);
    requireString(source.license, `${path}.license`, { maxLength: 256 });
    keys.push(`${source.source_id}\u0000${source.dataset_version}\u0000${source.feature_id}`);
  }
  assertUnique(keys, field);
  assertSorted(keys, field);
}

function expectedConfidenceTier(score) {
  if (score === 0) return 'unknown';
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

function validateConfidence(confidence, field) {
  const candidate = requireRecord(confidence, field);
  const score = requireFinite(candidate.score, `${field}.score`, { min: 0, max: 1 });
  const tier = requireString(candidate.tier, `${field}.tier`);
  if (tier !== expectedConfidenceTier(score)) {
    fail('confidence_tier_mismatch', `${field}.tier does not match its score.`, { field, score, tier });
  }
  if (!Array.isArray(candidate.reasons) || candidate.reasons.length === 0) {
    fail('missing_confidence_reason', `${field}.reasons must explain the classification.`, { field });
  }
  candidate.reasons.forEach((reason, index) => requireString(reason, `${field}.reasons[${index}]`, { maxLength: 160 }));
  assertUnique(candidate.reasons, `${field}.reasons`);
  assertSorted(candidate.reasons, `${field}.reasons`);
}

function validateOpportunity(opportunity, role, field) {
  if (role !== 'opportunity') {
    if (opportunity !== null) {
      fail('non_opportunity_workload', `${field} must be null unless canvas_role is opportunity.`, { field, role });
    }
    return;
  }
  const candidate = requireRecord(opportunity, field);
  const min = requireFinite(candidate.min, `${field}.min`, { min: 0 });
  const expected = requireFinite(candidate.expected, `${field}.expected`, { min: 0 });
  const max = requireFinite(candidate.max, `${field}.max`, { min: 0 });
  if (min > expected || expected > max) {
    fail('invalid_opportunity_range', `${field} must satisfy min <= expected <= max.`, { field });
  }
}

function validateGeometry(geometry, field, limits) {
  const candidate = requireRecord(geometry, field);
  if (candidate.type !== 'LineString' || !Array.isArray(candidate.coordinates) || candidate.coordinates.length < 2) {
    fail('invalid_work_unit_geometry', `${field} must be a LineString with at least two coordinates.`, { field });
  }
  if (candidate.coordinates.length > limits.max_coordinates_per_work_unit) {
    fail('geometry_limit_exceeded', `${field} exceeds the coordinate limit.`, { field, limit: limits.max_coordinates_per_work_unit });
  }
  for (const [index, coordinate] of candidate.coordinates.entries()) {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
      fail('invalid_coordinate', `${field}.coordinates[${index}] must be [longitude, latitude].`, { field, index });
    }
    requireFinite(coordinate[0], `${field}.coordinates[${index}][0]`, { min: -180, max: 180 });
    requireFinite(coordinate[1], `${field}.coordinates[${index}][1]`, { min: -90, max: 90 });
  }
}

function validateLimits(limits) {
  const candidate = { ...DEFAULT_CANVAS_EVIDENCE_LIMITS, ...requireRecord(limits, 'limits') };
  for (const [name, value] of Object.entries(candidate)) requireFinite(value, `limits.${name}`, { min: 1 });
  return candidate;
}

export function validateCanvasEvidenceTile(tile, suppliedLimits = DEFAULT_CANVAS_EVIDENCE_LIMITS) {
  const candidate = requireRecord(tile, 'tile');
  const limits = validateLimits(suppliedLimits);
  if (candidate.schema !== CANVAS_EVIDENCE_SCHEMA.tile || candidate.schema_version !== CANVAS_EVIDENCE_SCHEMA.version) {
    fail('unsupported_tile_schema', 'Canvas evidence tile schema is unsupported.');
  }
  requireString(candidate.release_id, 'tile.release_id', { pattern: ID_PATTERNS.release });
  requireString(candidate.tile_id, 'tile.tile_id', { pattern: ID_PATTERNS.tile });
  const address = canonicalTileAddress(candidate.tile_address);
  if (canonicalTileId(address) !== candidate.tile_id) fail('tile_id_mismatch', 'tile_id does not match tile_address.');
  requireRecord(candidate.coverage, 'tile.coverage');
  const areaSqMi = requireFinite(candidate.coverage.area_sq_mi, 'tile.coverage.area_sq_mi', { min: Number.EPSILON });
  validateBounds(candidate.coverage.bounds, 'tile.coverage.bounds');

  if (!Array.isArray(candidate.external_neighbor_ids)) fail('invalid_external_neighbors', 'tile.external_neighbor_ids must be an array.');
  candidate.external_neighbor_ids.forEach((id, index) => requireString(id, `tile.external_neighbor_ids[${index}]`, { pattern: ID_PATTERNS.workUnit }));
  assertUnique(candidate.external_neighbor_ids, 'tile.external_neighbor_ids');
  assertSorted(candidate.external_neighbor_ids, 'tile.external_neighbor_ids');

  if (!Array.isArray(candidate.work_units)) fail('invalid_work_units', 'tile.work_units must be an array.');
  if (candidate.work_units.length > limits.max_work_units_per_tile) {
    fail('work_unit_limit_exceeded', 'Tile exceeds the work-unit count limit.', { actual: candidate.work_units.length, limit: limits.max_work_units_per_tile });
  }
  const workUnitIds = candidate.work_units.map((unit) => unit?.work_unit_id);
  assertUnique(workUnitIds, 'tile.work_units.work_unit_id');
  assertSorted(workUnitIds, 'tile.work_units.work_unit_id');
  const localIds = new Set(workUnitIds);
  const externalIds = new Set(candidate.external_neighbor_ids);
  const neighborsById = new Map();
  let expectedOpportunities = 0;

  for (const [index, unit] of candidate.work_units.entries()) {
    const field = `tile.work_units[${index}]`;
    requireRecord(unit, field);
    requireString(unit.work_unit_id, `${field}.work_unit_id`, { pattern: ID_PATTERNS.workUnit });
    const descriptor = canonicalWorkUnitDescriptor(unit.identity);
    if (canonicalWorkUnitId(descriptor) !== unit.work_unit_id) fail('work_unit_id_mismatch', `${field}.work_unit_id does not match identity.`, { field });
    if (!CANVAS_EVIDENCE_ROLES.includes(unit.canvas_role)) fail('invalid_canvas_role', `${field}.canvas_role is unsupported.`, { field, role: unit.canvas_role });
    validateConfidence(unit.confidence, `${field}.confidence`);
    validateOpportunity(unit.opportunity, unit.canvas_role, `${field}.opportunity`);
    if (unit.opportunity) expectedOpportunities += unit.opportunity.expected;
    validateProvenance(unit.provenance, `${field}.provenance`);
    validateGeometry(unit.geometry, `${field}.geometry`, limits);
    if (!Array.isArray(unit.neighbor_ids)) fail('invalid_neighbors', `${field}.neighbor_ids must be an array.`, { field });
    if (unit.neighbor_ids.length > limits.max_neighbors_per_work_unit) {
      fail('neighbor_limit_exceeded', `${field} exceeds the neighbor limit.`, { field, limit: limits.max_neighbors_per_work_unit });
    }
    unit.neighbor_ids.forEach((id, neighborIndex) => requireString(id, `${field}.neighbor_ids[${neighborIndex}]`, { pattern: ID_PATTERNS.workUnit }));
    assertUnique(unit.neighbor_ids, `${field}.neighbor_ids`);
    assertSorted(unit.neighbor_ids, `${field}.neighbor_ids`);
    if (unit.neighbor_ids.includes(unit.work_unit_id)) fail('self_neighbor', `${field} cannot reference itself.`, { field });
    for (const neighborId of unit.neighbor_ids) {
      if (!localIds.has(neighborId) && !externalIds.has(neighborId)) {
        fail('unknown_neighbor', `${field} references a neighbor absent from this tile and external_neighbor_ids.`, { field, neighbor_id: neighborId });
      }
    }
    neighborsById.set(unit.work_unit_id, unit.neighbor_ids);
    if (unit.protected_group_id !== null) requireString(unit.protected_group_id, `${field}.protected_group_id`, { pattern: ID_PATTERNS.protectedGroup });
  }

  for (const [workUnitId, neighborIds] of neighborsById) {
    for (const neighborId of neighborIds) {
      if (localIds.has(neighborId) && !neighborsById.get(neighborId)?.includes(workUnitId)) {
        fail('asymmetric_topology', 'Local work-unit neighbor links must be symmetric.', { work_unit_id: workUnitId, neighbor_id: neighborId });
      }
    }
  }

  if (!Array.isArray(candidate.protected_groups)) fail('invalid_protected_groups', 'tile.protected_groups must be an array.');
  if (candidate.protected_groups.length > limits.max_protected_groups_per_tile) {
    fail('protected_group_limit_exceeded', 'Tile exceeds the protected-group limit.', { actual: candidate.protected_groups.length, limit: limits.max_protected_groups_per_tile });
  }
  const protectedIds = candidate.protected_groups.map((group) => group?.protected_group_id);
  assertUnique(protectedIds, 'tile.protected_groups.protected_group_id');
  assertSorted(protectedIds, 'tile.protected_groups.protected_group_id');
  const groupedWorkUnits = new Map();
  for (const [index, group] of candidate.protected_groups.entries()) {
    const field = `tile.protected_groups[${index}]`;
    requireRecord(group, field);
    requireString(group.kind, `${field}.kind`, { pattern: /^[a-z][a-z0-9_]{0,63}$/, maxLength: 64 });
    requireString(group.protected_group_id, `${field}.protected_group_id`, { pattern: ID_PATTERNS.protectedGroup });
    if (!Array.isArray(group.member_work_unit_ids) || group.member_work_unit_ids.length === 0) {
      fail('empty_protected_group', `${field} must contain at least one member.`, { field });
    }
    group.member_work_unit_ids.forEach((id) => requireString(id, `${field}.member_work_unit_ids`, { pattern: ID_PATTERNS.workUnit }));
    assertUnique(group.member_work_unit_ids, `${field}.member_work_unit_ids`);
    assertSorted(group.member_work_unit_ids, `${field}.member_work_unit_ids`);
    if (canonicalProtectedGroupId(group.kind, group.member_work_unit_ids) !== group.protected_group_id) {
      fail('protected_group_id_mismatch', `${field}.protected_group_id does not match its members.`, { field });
    }
    if (!Array.isArray(group.entry_work_unit_ids)) fail('invalid_group_entries', `${field}.entry_work_unit_ids must be an array.`, { field });
    assertUnique(group.entry_work_unit_ids, `${field}.entry_work_unit_ids`);
    assertSorted(group.entry_work_unit_ids, `${field}.entry_work_unit_ids`);
    for (const id of group.entry_work_unit_ids) {
      if (!group.member_work_unit_ids.includes(id)) fail('entry_outside_protected_group', `${field} contains an entry outside its members.`, { field, work_unit_id: id });
    }
    for (const id of group.member_work_unit_ids) {
      if (!localIds.has(id)) fail('unknown_protected_member', `${field} references a work unit outside its tile.`, { field, work_unit_id: id });
      if (groupedWorkUnits.has(id)) fail('overlapping_protected_groups', 'A work unit cannot belong to multiple protected groups.', { work_unit_id: id });
      groupedWorkUnits.set(id, group.protected_group_id);
    }
  }
  for (const unit of candidate.work_units) {
    if ((groupedWorkUnits.get(unit.work_unit_id) || null) !== unit.protected_group_id) {
      fail('protected_group_membership_mismatch', 'Work-unit and protected-group membership disagree.', { work_unit_id: unit.work_unit_id });
    }
  }

  const properties = candidate.properties === undefined ? [] : candidate.properties;
  if (!Array.isArray(properties)) fail('invalid_properties', 'tile.properties must be an array.');
  if (properties.length > limits.max_properties_per_tile) {
    fail('property_limit_exceeded', 'Tile exceeds the property count limit.', { actual: properties.length, limit: limits.max_properties_per_tile });
  }
  const propertyIds = properties.map((property) => property?.property_id);
  assertUnique(propertyIds, 'tile.properties.property_id');
  assertSorted(propertyIds, 'tile.properties.property_id');
  let eligibleDoorCount = 0;
  for (const [index, property] of properties.entries()) {
    const field = `tile.properties[${index}]`;
    requireRecord(property, field);
    requireString(property.property_id, `${field}.property_id`, { pattern: ID_PATTERNS.property });
    const propertyKey = requireString(property.property_key, `${field}.property_key`, { maxLength: 256 });
    if (canonicalPropertyId(propertyKey) !== property.property_id) fail('property_id_mismatch', `${field}.property_id does not match property_key.`, { field });
    requireString(property.work_unit_id, `${field}.work_unit_id`, { pattern: ID_PATTERNS.workUnit });
    if (!localIds.has(property.work_unit_id)) fail('property_work_unit_missing', `${field} references a work unit outside its tile.`, { field });
    if (!['residential', 'multifamily', 'commercial', 'government', 'institutional', 'vacant', 'unknown'].includes(property.property_type)) fail('invalid_property_type', `${field}.property_type is unsupported.`, { field });
    if (!['eligible', 'excluded', 'review'].includes(property.canvass_eligibility)) fail('invalid_canvass_eligibility', `${field}.canvass_eligibility is unsupported.`, { field });
    const doorCount = requireInteger(property.door_count, `${field}.door_count`, { min: 1, max: 100_000 });
    if (property.canvass_eligibility === 'eligible') eligibleDoorCount += doorCount;
    validateConfidence(property.confidence, `${field}.confidence`);
    validateProvenance(property.provenance, `${field}.provenance`);
    requireRecord(property.point, `${field}.point`);
    const lat = requireFinite(property.point.lat, `${field}.point.lat`, { min: -90, max: 90 });
    const lng = requireFinite(property.point.lng, `${field}.point.lng`, { min: -180, max: 180 });
    if (lat < candidate.coverage.bounds.min_lat || lat > candidate.coverage.bounds.max_lat || lng < candidate.coverage.bounds.min_lng || lng > candidate.coverage.bounds.max_lng) fail('property_outside_tile', `${field}.point is outside tile coverage.`, { field });
    if (property.display_address !== undefined) requireString(property.display_address, `${field}.display_address`, { maxLength: 500 });
  }

  const propertiesPerSqMi = properties.length / areaSqMi;
  if (propertiesPerSqMi > limits.max_properties_per_sq_mi) {
    fail('property_density_exceeded', 'Tile exceeds the property density limit.', { actual: propertiesPerSqMi, limit: limits.max_properties_per_sq_mi });
  }

  const workUnitsPerSqMi = candidate.work_units.length / areaSqMi;
  if (workUnitsPerSqMi > limits.max_work_units_per_sq_mi) {
    fail('work_unit_density_exceeded', 'Tile exceeds the work-unit density limit.', { actual: workUnitsPerSqMi, limit: limits.max_work_units_per_sq_mi });
  }
  const opportunitiesPerSqMi = expectedOpportunities / areaSqMi;
  if (opportunitiesPerSqMi > limits.max_expected_opportunities_per_sq_mi) {
    fail('opportunity_density_exceeded', 'Tile exceeds the expected-opportunity density limit.', { actual: opportunitiesPerSqMi, limit: limits.max_expected_opportunities_per_sq_mi });
  }
  const canonicalBytes = Buffer.byteLength(canonicalStringify(candidate), 'utf8');
  if (canonicalBytes > limits.max_tile_bytes) {
    fail('tile_byte_limit_exceeded', 'Tile exceeds the canonical byte limit.', { actual: canonicalBytes, limit: limits.max_tile_bytes });
  }
  return Object.freeze({
    canonical_bytes: canonicalBytes,
    work_unit_count: candidate.work_units.length,
    work_units_per_sq_mi: workUnitsPerSqMi,
    expected_opportunities: expectedOpportunities,
    expected_opportunities_per_sq_mi: opportunitiesPerSqMi,
    property_count: properties.length,
    properties_per_sq_mi: propertiesPerSqMi,
    eligible_door_count: eligibleDoorCount,
  });
}

function validateSource(source, field) {
  requireRecord(source, field);
  requireString(source.source_id, `${field}.source_id`, { pattern: /^[a-z][a-z0-9._-]{0,127}$/, maxLength: 128 });
  requireString(source.provider, `${field}.provider`, { maxLength: 128 });
  requireString(source.dataset_version, `${field}.dataset_version`, { maxLength: 128 });
  requireString(source.license, `${field}.license`, { maxLength: 256 });
  requireIsoInstant(source.captured_at, `${field}.captured_at`);
}

export function unsignedManifest(manifest) {
  const candidate = requireRecord(manifest, 'manifest');
  const { signature: _signature, ...unsigned } = candidate;
  return unsigned;
}

export function manifestSigningPayload(manifest) {
  return Buffer.from(canonicalStringify(unsignedManifest(manifest)), 'utf8');
}

export function validateCanvasEvidenceManifest(manifest, { requireSignature = true } = {}) {
  const candidate = requireRecord(manifest, 'manifest');
  if (candidate.schema !== CANVAS_EVIDENCE_SCHEMA.manifest || candidate.schema_version !== CANVAS_EVIDENCE_SCHEMA.version) {
    fail('unsupported_manifest_schema', 'Canvas evidence manifest schema is unsupported.');
  }
  requireRecord(candidate.release, 'manifest.release');
  requireString(candidate.release.release_id, 'manifest.release.release_id', { pattern: ID_PATTERNS.release });
  const expectedReleaseId = canonicalReleaseId(candidate.release);
  if (expectedReleaseId !== candidate.release.release_id) fail('release_id_mismatch', 'release_id does not match release metadata.');
  requireString(candidate.release.dataset_namespace, 'manifest.release.dataset_namespace');
  requireString(candidate.release.dataset_version, 'manifest.release.dataset_version');
  requireIsoInstant(candidate.release.generated_at, 'manifest.release.generated_at');
  requireString(candidate.release.compiler_version, 'manifest.release.compiler_version', { maxLength: 128 });
  requireRecord(candidate.coverage, 'manifest.coverage');
  validateBounds(candidate.coverage.bounds, 'manifest.coverage.bounds');
  if (!Array.isArray(candidate.coverage.country_codes) || candidate.coverage.country_codes.length === 0) {
    fail('missing_country_coverage', 'manifest.coverage.country_codes must not be empty.');
  }
  candidate.coverage.country_codes.forEach((code, index) => requireString(code, `manifest.coverage.country_codes[${index}]`, { pattern: /^[A-Z]{2}$/, maxLength: 2 }));
  assertUnique(candidate.coverage.country_codes, 'manifest.coverage.country_codes');
  assertSorted(candidate.coverage.country_codes, 'manifest.coverage.country_codes');
  canonicalTileAddress({
    scheme: candidate.tile_scheme?.scheme,
    scheme_version: candidate.tile_scheme?.scheme_version,
    key: 'contract-validation-placeholder',
  });
  const limits = validateLimits(candidate.limits);

  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) fail('missing_sources', 'manifest.sources must not be empty.');
  candidate.sources.forEach((source, index) => validateSource(source, `manifest.sources[${index}]`));
  const sourceIds = candidate.sources.map((source) => source.source_id);
  assertUnique(sourceIds, 'manifest.sources.source_id');
  assertSorted(sourceIds, 'manifest.sources.source_id');

  if (!Array.isArray(candidate.tiles) || candidate.tiles.length === 0) fail('missing_tiles', 'manifest.tiles must not be empty.');
  if (candidate.tiles.length > limits.max_tiles_per_release) {
    fail('release_tile_limit_exceeded', 'Manifest exceeds the tile count limit.', { actual: candidate.tiles.length, limit: limits.max_tiles_per_release });
  }
  const tileIds = candidate.tiles.map((tile) => tile?.tile_id);
  assertUnique(tileIds, 'manifest.tiles.tile_id');
  assertSorted(tileIds, 'manifest.tiles.tile_id');
  for (const [index, tile] of candidate.tiles.entries()) {
    const field = `manifest.tiles[${index}]`;
    requireRecord(tile, field);
    requireString(tile.tile_id, `${field}.tile_id`, { pattern: ID_PATTERNS.tile });
    const address = canonicalTileAddress(tile.tile_address);
    if (canonicalTileId(address) !== tile.tile_id) fail('manifest_tile_id_mismatch', `${field}.tile_id does not match tile_address.`, { field });
    if (address.scheme !== candidate.tile_scheme.scheme || address.scheme_version !== candidate.tile_scheme.scheme_version) {
      fail('mixed_tile_scheme', `${field} does not use the release tile scheme.`, { field });
    }
    requireString(tile.uri, `${field}.uri`, { pattern: /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, maxLength: 512 });
    requireString(tile.sha256, `${field}.sha256`, { pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
    requireInteger(tile.byte_length, `${field}.byte_length`, { min: 1, max: limits.max_tile_bytes });
    requireInteger(tile.work_unit_count, `${field}.work_unit_count`, { max: limits.max_work_units_per_tile });
    requireInteger(tile.property_count, `${field}.property_count`, { max: limits.max_properties_per_tile });
    requireFinite(tile.coverage_area_sq_mi, `${field}.coverage_area_sq_mi`, { min: Number.EPSILON });
    validateBounds(tile.coverage_bounds, `${field}.coverage_bounds`);
    requireFinite(tile.expected_opportunities, `${field}.expected_opportunities`, { min: 0 });
  }

  if (requireSignature) {
    requireRecord(candidate.signature, 'manifest.signature');
    if (candidate.signature.algorithm !== 'Ed25519') fail('unsupported_signature_algorithm', 'Manifest signature algorithm must be Ed25519.');
    requireString(candidate.signature.key_id, 'manifest.signature.key_id', { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, maxLength: 128 });
    requireString(candidate.signature.value, 'manifest.signature.value', { pattern: /^[A-Za-z0-9_-]{86}$/, maxLength: 86 });
  } else if (candidate.signature !== undefined) {
    fail('unexpected_signature', 'Unsigned manifest input must not include a signature.');
  }
  return Object.freeze({ release_id: candidate.release.release_id, tile_count: candidate.tiles.length });
}

export function signCanvasEvidenceManifest(manifest, { privateKey, keyId }) {
  validateCanvasEvidenceManifest(manifest, { requireSignature: false });
  requireString(keyId, 'signing.key_id', { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, maxLength: 128 });
  const signature = signBytes(null, manifestSigningPayload(manifest), privateKey).toString('base64url');
  const signed = {
    ...manifest,
    signature: { algorithm: 'Ed25519', key_id: keyId, value: signature },
  };
  validateCanvasEvidenceManifest(signed);
  return signed;
}

export function verifyCanvasEvidenceManifest(manifest, { publicKey, expectedKeyId } = {}) {
  validateCanvasEvidenceManifest(manifest);
  if (expectedKeyId !== undefined && manifest.signature.key_id !== expectedKeyId) return false;
  try {
    return verifyBytes(null, manifestSigningPayload(manifest), publicKey, Buffer.from(manifest.signature.value, 'base64url'));
  } catch {
    return false;
  }
}

export function validateCanvasEvidenceBundle({ manifest, tiles, publicKey, expectedKeyId }) {
  if (!verifyCanvasEvidenceManifest(manifest, { publicKey, expectedKeyId })) {
    fail('manifest_signature_invalid', 'Canvas evidence manifest signature verification failed.');
  }
  const tileEntries = tiles instanceof Map ? tiles : new Map(Object.entries(requireRecord(tiles, 'tiles')));
  const expectedTileIds = new Set(manifest.tiles.map((entry) => entry.tile_id));
  if (tileEntries.size !== expectedTileIds.size) fail('bundle_tile_count_mismatch', 'Bundle tile count does not match its manifest.');
  for (const entry of manifest.tiles) {
    const tile = tileEntries.get(entry.tile_id);
    if (!tile) fail('bundle_tile_missing', 'A manifest tile is missing from the bundle.', { tile_id: entry.tile_id });
    if (tile.release_id !== manifest.release.release_id) fail('bundle_release_mismatch', 'Tile belongs to a different release.', { tile_id: entry.tile_id });
    const metrics = validateCanvasEvidenceTile(tile, manifest.limits);
    const bytes = Buffer.from(canonicalStringify(tile), 'utf8');
    if (sha256Hex(bytes) !== entry.sha256) fail('bundle_tile_digest_mismatch', 'Tile digest does not match the manifest.', { tile_id: entry.tile_id });
    if (bytes.byteLength !== entry.byte_length || metrics.work_unit_count !== entry.work_unit_count || metrics.property_count !== entry.property_count) {
      fail('bundle_tile_metrics_mismatch', 'Tile metrics do not match the manifest.', { tile_id: entry.tile_id });
    }
    if (
      tile.coverage.area_sq_mi !== entry.coverage_area_sq_mi
      || canonicalStringify(tile.coverage.bounds) !== canonicalStringify(entry.coverage_bounds)
      || metrics.expected_opportunities !== entry.expected_opportunities
    ) {
      fail('bundle_tile_coverage_mismatch', 'Tile coverage metrics do not match the manifest.', { tile_id: entry.tile_id });
    }
  }
  for (const tileId of tileEntries.keys()) {
    if (!expectedTileIds.has(tileId)) fail('bundle_tile_unlisted', 'Bundle contains a tile absent from the manifest.', { tile_id: tileId });
  }
  return Object.freeze({ release_id: manifest.release.release_id, tile_count: tileEntries.size });
}

function polygonCoordinates(polygon) {
  const coordinates = polygon?.type === 'Polygon' ? polygon.coordinates?.[0] : polygon;
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    fail('invalid_selection_polygon', 'Canvas selection polygon must contain at least three [longitude, latitude] coordinates.');
  }
  return coordinates.map((coordinate, index) => {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
      fail('invalid_selection_coordinate', `Selection coordinate ${index} must be [longitude, latitude].`, { index });
    }
    return [
      requireFinite(coordinate[0], `selection_polygon[${index}][0]`, { min: -180, max: 180 }),
      requireFinite(coordinate[1], `selection_polygon[${index}][1]`, { min: -90, max: 90 }),
    ];
  });
}

function selectionBounds(coordinates) {
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  const bounds = {
    min_lng: Math.min(...longitudes),
    min_lat: Math.min(...latitudes),
    max_lng: Math.max(...longitudes),
    max_lat: Math.max(...latitudes),
  };
  validateBounds(bounds, 'selection_bounds');
  return bounds;
}

function boundsIntersect(left, right) {
  return !(
    left.max_lng < right.min_lng
    || left.min_lng > right.max_lng
    || left.max_lat < right.min_lat
    || left.min_lat > right.max_lat
  );
}

function pointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-12) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-12
    && point[0] <= Math.max(start[0], end[0]) + 1e-12
    && point[1] >= Math.min(start[1], end[1]) - 1e-12
    && point[1] <= Math.max(start[1], end[1]) + 1e-12;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(point, start, end)) return true;
    const crossesLatitude = (end[1] > point[1]) !== (start[1] > point[1]);
    if (crossesLatitude) {
      const intersectionLongitude = ((start[0] - end[0]) * (point[1] - end[1])) / (start[1] - end[1]) + end[0];
      if (point[0] < intersectionLongitude) inside = !inside;
    }
  }
  return inside;
}

function orientation(first, second, third) {
  const value = (second[1] - first[1]) * (third[0] - second[0]) - (second[0] - first[0]) * (third[1] - second[1]);
  if (Math.abs(value) <= 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  if (firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation) return true;
  return (firstOrientation === 0 && pointOnSegment(secondStart, firstStart, firstEnd))
    || (secondOrientation === 0 && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (thirdOrientation === 0 && pointOnSegment(firstStart, secondStart, secondEnd))
    || (fourthOrientation === 0 && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function lineIntersectsPolygon(line, polygon) {
  if (line.some((point) => pointInPolygon(point, polygon))) return true;
  for (let lineIndex = 1; lineIndex < line.length; lineIndex += 1) {
    for (let polygonIndex = 0; polygonIndex < polygon.length; polygonIndex += 1) {
      const nextPolygonIndex = (polygonIndex + 1) % polygon.length;
      if (segmentsIntersect(line[lineIndex - 1], line[lineIndex], polygon[polygonIndex], polygon[nextPolygonIndex])) return true;
    }
  }
  return false;
}

export function selectCanvasEvidenceTiles(manifest, polygon) {
  validateCanvasEvidenceManifest(manifest);
  const coordinates = polygonCoordinates(polygon);
  const bounds = selectionBounds(coordinates);
  return manifest.tiles.filter((entry) => boundsIntersect(entry.coverage_bounds, bounds));
}

export function selectCanvasEvidenceWorkUnits(tile, polygon, suppliedLimits = DEFAULT_CANVAS_EVIDENCE_LIMITS) {
  validateCanvasEvidenceTile(tile, suppliedLimits);
  const coordinates = polygonCoordinates(polygon);
  const selectedIds = new Set(
    tile.work_units
      .filter((unit) => lineIntersectsPolygon(unit.geometry.coordinates, coordinates))
      .map((unit) => unit.work_unit_id),
  );

  // Protected topology is atomic: selecting any member selects the whole cul-de-sac/pocket.
  for (const group of tile.protected_groups) {
    if (group.member_work_unit_ids.some((id) => selectedIds.has(id))) {
      group.member_work_unit_ids.forEach((id) => selectedIds.add(id));
    }
  }

  const workUnits = tile.work_units.filter((unit) => selectedIds.has(unit.work_unit_id));
  const properties = (tile.properties || []).filter((property) => pointInPolygon([property.point.lng, property.point.lat], coordinates));
  const protectedGroups = tile.protected_groups.filter((group) => (
    group.member_work_unit_ids.some((id) => selectedIds.has(id))
  ));
  const externalNeighborIds = new Set();
  for (const unit of workUnits) {
    for (const neighborId of unit.neighbor_ids) {
      if (!selectedIds.has(neighborId)) externalNeighborIds.add(neighborId);
    }
  }
  return Object.freeze({
    release_id: tile.release_id,
    source_tile_id: tile.tile_id,
    work_units: workUnits,
    properties,
    protected_groups: protectedGroups,
    external_neighbor_ids: [...externalNeighborIds].sort(),
  });
}