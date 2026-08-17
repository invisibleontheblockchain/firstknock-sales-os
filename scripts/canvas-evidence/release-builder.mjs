import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
} from 'node:crypto';
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  CANVAS_EVIDENCE_SCHEMA,
  DEFAULT_CANVAS_EVIDENCE_LIMITS,
  canonicalPropertyId,
  canonicalProtectedGroupId,
  canonicalReleaseId,
  canonicalStringify,
  canonicalTileAddress,
  canonicalTileId,
  canonicalWorkUnitDescriptor,
  canonicalWorkUnitId,
  sha256Hex,
  signCanvasEvidenceManifest,
  validateCanvasEvidenceManifest,
  validateCanvasEvidenceTile,
  verifyCanvasEvidenceManifest,
} from './contract.mjs';
import { compileCanvasEvidenceTile } from './compiler.mjs';

export const NORMALIZED_RELEASE_SCHEMA = 'firstknock.canvas-normalized-evidence-release';
export const NORMALIZED_TILE_SCHEMA = 'firstknock.canvas-normalized-evidence-tile';
export const UPLOAD_INVENTORY_SCHEMA = 'firstknock.canvas-evidence-upload-inventory';
export const PRODUCTION_COMPILER_VERSION = 'firstknock-canvas-evidence-release-compiler/1.1.0';

const NORMALIZED_SCHEMA_VERSION = 1;
const DEFAULT_TOPOLOGY_BUCKETS = 256;
const DEFAULT_SPOOL_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_NDJSON_LINE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_INPUT_BYTES = 64 * 1024 * 1024;
const FIXTURE_KEY_ID = 'firstknock-local-fixture-v1';
const FIXTURE_PUBLIC_KEY_SHA256 = '5b21d82723b227cb48aa02fdf2fe44b6e262a71348edfa39329208e47b5a462c';
const INPUT_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson']);
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export class CanvasEvidenceReleaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasEvidenceReleaseError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanvasEvidenceReleaseError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) fail('invalid_normalized_record', `${field} must be an object.`, { field });
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail('invalid_normalized_array', `${field} must be an array.`, { field });
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail('invalid_normalized_string', `${field} must be a non-empty, trimmed string.`, { field });
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(requireRecord(value, field))) {
    if (!allowed.has(key)) fail('unknown_normalized_field', `${field}.${key} is not part of normalized evidence v1.`, { field: `${field}.${key}` });
  }
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareCanonical(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function isInsideBounds(inner, outer, epsilon = 1e-9) {
  return inner.min_lng >= outer.min_lng - epsilon
    && inner.max_lng <= outer.max_lng + epsilon
    && inner.min_lat >= outer.min_lat - epsilon
    && inner.max_lat <= outer.max_lat + epsilon;
}

function publicKeyFingerprint(publicKey) {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function resolveProductionSigningMaterial({ privateKey, publicKey, keyId }) {
  requireString(keyId, 'signing.key_id');
  if (keyId === FIXTURE_KEY_ID) {
    fail('fixture_signing_key_forbidden', 'The checked-in fixture signing key ID cannot sign a production evidence release.');
  }
  let privateKeyObject;
  try {
    privateKeyObject = createPrivateKey(privateKey);
  } catch (error) {
    fail('invalid_private_key', 'The evidence signing private key could not be parsed.', { cause: error.message });
  }
  if (privateKeyObject.asymmetricKeyType !== 'ed25519') {
    fail('invalid_signing_algorithm', 'Canvas evidence releases require an Ed25519 private key.');
  }
  const derivedPublicKey = createPublicKey(privateKeyObject);
  let publicKeyObject = derivedPublicKey;
  if (publicKey !== undefined && publicKey !== null) {
    try {
      publicKeyObject = createPublicKey(publicKey);
    } catch (error) {
      fail('invalid_public_key', 'The evidence verification public key could not be parsed.', { cause: error.message });
    }
    if (publicKeyObject.asymmetricKeyType !== 'ed25519') {
      fail('invalid_signing_algorithm', 'Canvas evidence releases require an Ed25519 public key.');
    }
    if (!derivedPublicKey.export({ type: 'spki', format: 'der' }).equals(publicKeyObject.export({ type: 'spki', format: 'der' }))) {
      fail('signing_key_mismatch', 'The supplied public key does not match the private signing key.');
    }
  }
  const fingerprint = publicKeyFingerprint(publicKeyObject);
  if (fingerprint === FIXTURE_PUBLIC_KEY_SHA256) {
    fail('fixture_signing_key_forbidden', 'The checked-in fixture keypair cannot sign a production evidence release.');
  }
  return Object.freeze({
    privateKey: privateKeyObject,
    publicKey: publicKeyObject,
    keyId,
    publicKeySha256: fingerprint,
  });
}

function normalizedReleaseMetadata(input) {
  const metadata = requireRecord(input, 'release_metadata');
  assertAllowedKeys(metadata, new Set([
    'schema',
    'schema_version',
    'release',
    'coverage',
    'tile_scheme',
    'limits',
    'sources',
    'tile_inputs',
  ]), 'release_metadata');
  if (metadata.schema !== NORMALIZED_RELEASE_SCHEMA || metadata.schema_version !== NORMALIZED_SCHEMA_VERSION) {
    fail('unsupported_normalized_release_schema', 'Normalized release metadata must use the production v1 input schema.');
  }
  requireRecord(metadata.release, 'release_metadata.release');
  requireRecord(metadata.coverage, 'release_metadata.coverage');
  requireRecord(metadata.tile_scheme, 'release_metadata.tile_scheme');
  const tileScheme = canonicalTileAddress({
    scheme: metadata.tile_scheme.scheme,
    scheme_version: metadata.tile_scheme.scheme_version,
    key: 'normalized-release-validation',
  });
  const limits = { ...DEFAULT_CANVAS_EVIDENCE_LIMITS, ...(metadata.limits || {}) };
  const sources = copyJson(requireArray(metadata.sources, 'release_metadata.sources'))
    .sort((left, right) => String(left?.source_id || '').localeCompare(String(right?.source_id || '')));
  const sourceById = new Map();
  for (const [index, source] of sources.entries()) {
    requireRecord(source, `release_metadata.sources[${index}]`);
    requireString(source.source_id, `release_metadata.sources[${index}].source_id`);
    if (sourceById.has(source.source_id)) fail('duplicate_source', `Source ${source.source_id} is listed more than once.`);
    const capturedAt = new Date(source.captured_at).valueOf();
    const generatedAt = new Date(metadata.release.generated_at).valueOf();
    if (Number.isFinite(capturedAt) && Number.isFinite(generatedAt) && capturedAt > generatedAt) {
      fail('future_release_source', `Source ${source.source_id} was captured after the release generation time.`, { source_id: source.source_id });
    }
    sourceById.set(source.source_id, source);
  }
  const release = copyJson(metadata.release);
  const releaseId = canonicalReleaseId(release);
  const unsignedProbe = {
    schema: CANVAS_EVIDENCE_SCHEMA.manifest,
    schema_version: CANVAS_EVIDENCE_SCHEMA.version,
    release: {
      release_id: releaseId,
      dataset_namespace: release.dataset_namespace.toLowerCase(),
      dataset_version: release.dataset_version,
      generated_at: release.generated_at,
      compiler_version: PRODUCTION_COMPILER_VERSION,
    },
    coverage: copyJson(metadata.coverage),
    tile_scheme: { scheme: tileScheme.scheme, scheme_version: tileScheme.scheme_version },
    limits,
    sources,
    tiles: [],
  };
  return {
    ...unsignedProbe,
    releaseId,
    sourceById,
    tileInputs: metadata.tile_inputs === undefined
      ? []
      : requireArray(metadata.tile_inputs, 'release_metadata.tile_inputs').map((path, index) => (
        requireString(path, `release_metadata.tile_inputs[${index}]`)
      )),
  };
}

function validateUnitProvenance(unit, field, sourceById, generatedAt) {
  for (const [index, provenance] of requireArray(unit.provenance, `${field}.provenance`).entries()) {
    const path = `${field}.provenance[${index}]`;
    const source = sourceById.get(provenance?.source_id);
    if (!source) fail('unknown_provenance_source', `${path}.source_id is absent from release sources.`, { source_id: provenance?.source_id });
    if (provenance.dataset_version !== source.dataset_version || provenance.license !== source.license) {
      fail('provenance_release_mismatch', `${path} does not match the signed release source metadata.`, { source_id: source.source_id });
    }
    const observedAt = new Date(provenance.observed_at).valueOf();
    const releaseAt = new Date(generatedAt).valueOf();
    if (Number.isFinite(observedAt) && Number.isFinite(releaseAt) && observedAt > releaseAt) {
      fail('future_provenance', `${path}.observed_at is after the release generation time.`, { source_id: source.source_id });
    }
  }
}

function validateGeometryWithinTile(unit, tileBounds, field) {
  const coordinates = unit.geometry?.coordinates;
  if (!Array.isArray(coordinates)) return;
  for (const [index, coordinate] of coordinates.entries()) {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) continue;
    if (
      coordinate[0] < tileBounds.min_lng - 1e-9
      || coordinate[0] > tileBounds.max_lng + 1e-9
      || coordinate[1] < tileBounds.min_lat - 1e-9
      || coordinate[1] > tileBounds.max_lat + 1e-9
    ) {
      fail('geometry_outside_tile', `${field}.geometry.coordinates[${index}] is outside the tile coverage bounds.`, { field, index });
    }
  }
}

function validatePointWithinTile(point, tileBounds, field) {
  requireRecord(point, field);
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < tileBounds.min_lat || lat > tileBounds.max_lat
    || lng < tileBounds.min_lng || lng > tileBounds.max_lng) {
    fail('property_outside_tile', `${field} is outside tile coverage.`, { field });
  }
  return { lat, lng };
}

function normalizeNeighbor(neighbor, field) {
  assertAllowedKeys(neighbor, new Set(['identity', 'scope']), field);
  const identity = canonicalWorkUnitDescriptor(neighbor.identity);
  if (neighbor.scope !== 'release' && neighbor.scope !== 'outside_release') {
    fail('invalid_neighbor_scope', `${field}.scope must be release or outside_release.`, { field, scope: neighbor.scope });
  }
  return { identity, workUnitId: canonicalWorkUnitId(identity), scope: neighbor.scope };
}

export function compileNormalizedCanvasEvidenceTile(rawInput, context) {
  const rawTile = requireRecord(rawInput, context.field || 'normalized_tile');
  const field = context.field || 'normalized_tile';
  assertAllowedKeys(rawTile, new Set([
    'schema',
    'schema_version',
    'tile_address',
    'coverage',
    'work_units',
    'properties',
    'protected_groups',
  ]), field);
  if (rawTile.schema !== NORMALIZED_TILE_SCHEMA || rawTile.schema_version !== NORMALIZED_SCHEMA_VERSION) {
    fail('unsupported_normalized_tile_schema', `${field} must use the production v1 normalized tile schema.`, { field });
  }
  const tileAddress = canonicalTileAddress(rawTile.tile_address);
  if (tileAddress.scheme !== context.tileScheme.scheme || tileAddress.scheme_version !== context.tileScheme.scheme_version) {
    fail('mixed_tile_scheme', `${field}.tile_address does not use the release tile scheme.`, { field });
  }
  const coverage = copyJson(requireRecord(rawTile.coverage, `${field}.coverage`));
  const tileBounds = requireRecord(coverage.bounds, `${field}.coverage.bounds`);
  if (!isInsideBounds(tileBounds, context.releaseCoverage.bounds)) {
    fail('tile_outside_release_coverage', `${field}.coverage.bounds extends beyond the release coverage.`, { field });
  }
  const rawUnits = requireArray(rawTile.work_units, `${field}.work_units`);
  if (rawUnits.length === 0) fail('empty_normalized_tile', `${field}.work_units must not be empty.`);

  const unitById = new Map();
  const unitInputs = rawUnits.map((unit, index) => {
    const unitField = `${field}.work_units[${index}]`;
    assertAllowedKeys(unit, new Set([
      'identity',
      'canvas_role',
      'confidence',
      'opportunity',
      'provenance',
      'geometry',
      'neighbors',
    ]), unitField);
    const identity = canonicalWorkUnitDescriptor(unit.identity);
    const workUnitId = canonicalWorkUnitId(identity);
    if (unitById.has(workUnitId)) fail('duplicate_work_unit', `${field} contains duplicate work-unit identity ${workUnitId}.`, { work_unit_id: workUnitId });
    validateUnitProvenance(unit, unitField, context.sourceById, context.generatedAt);
    validateGeometryWithinTile(unit, tileBounds, unitField);
    const neighbors = requireArray(unit.neighbors, `${unitField}.neighbors`).map((neighbor, neighborIndex) => (
      normalizeNeighbor(neighbor, `${unitField}.neighbors[${neighborIndex}]`)
    ));
    const neighborIds = neighbors.map((neighbor) => neighbor.workUnitId);
    if (new Set(neighborIds).size !== neighborIds.length) {
      fail('duplicate_neighbor', `${unitField}.neighbors contains the same work unit more than once.`, { work_unit_id: workUnitId });
    }
    if (neighborIds.includes(workUnitId)) fail('self_neighbor', `${unitField} cannot reference itself.`, { work_unit_id: workUnitId });
    const normalized = { unit, identity, workUnitId, neighbors, unitField };
    unitById.set(workUnitId, normalized);
    return normalized;
  });

  const rawGroups = requireArray(rawTile.protected_groups || [], `${field}.protected_groups`);
  const membershipByUnitId = new Map();
  const fixtureGroups = rawGroups.map((group, index) => {
    const groupField = `${field}.protected_groups[${index}]`;
    assertAllowedKeys(group, new Set(['kind', 'members', 'entries']), groupField);
    requireString(group.kind, `${groupField}.kind`);
    const memberIds = requireArray(group.members, `${groupField}.members`)
      .map((identity) => canonicalWorkUnitId(canonicalWorkUnitDescriptor(identity)))
      .sort();
    if (memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
      fail('invalid_protected_group_members', `${groupField}.members must contain distinct local work units.`, { field: groupField });
    }
    for (const memberId of memberIds) {
      if (!unitById.has(memberId)) fail('protected_group_crosses_tile', `${groupField} references a work unit outside its tile.`, { work_unit_id: memberId });
      if (membershipByUnitId.has(memberId)) fail('overlapping_protected_groups', `${groupField} overlaps another protected group.`, { work_unit_id: memberId });
    }
    const entryIds = requireArray(group.entries || [], `${groupField}.entries`)
      .map((identity) => canonicalWorkUnitId(canonicalWorkUnitDescriptor(identity)))
      .sort();
    if (new Set(entryIds).size !== entryIds.length || entryIds.some((id) => !memberIds.includes(id))) {
      fail('invalid_protected_group_entries', `${groupField}.entries must be distinct protected-group members.`, { field: groupField });
    }
    const protectedGroupId = canonicalProtectedGroupId(group.kind, memberIds);
    for (const memberId of memberIds) membershipByUnitId.set(memberId, protectedGroupId);
    return {
      fixture_key: protectedGroupId,
      kind: group.kind,
      members: memberIds.map((id) => `unit:${id}`),
      entries: entryIds.map((id) => `unit:${id}`),
    };
  });

  const externalById = new Map();
  const topologyRecords = [];
  const fixtureUnits = unitInputs.map(({ unit, identity, workUnitId, neighbors, unitField }) => {
    topologyRecords.push({ type: 'unit', workUnitId });
    const localNeighbors = [];
    const externalNeighbors = [];
    for (const neighbor of neighbors) {
      const local = unitById.has(neighbor.workUnitId);
      if (neighbor.scope === 'outside_release' && local) {
        fail('outside_release_neighbor_is_internal', `${unitField} marks a local work unit as outside_release.`, { neighbor_id: neighbor.workUnitId });
      }
      if (local) localNeighbors.push(`unit:${neighbor.workUnitId}`);
      else {
        externalNeighbors.push(`external:${neighbor.workUnitId}`);
        const existing = externalById.get(neighbor.workUnitId);
        if (existing && !compareCanonical(existing.identity, neighbor.identity)) {
          fail('work_unit_id_collision', `${unitField} contains conflicting identities with the same canonical ID.`, { work_unit_id: neighbor.workUnitId });
        }
        externalById.set(neighbor.workUnitId, {
          fixture_key: `external:${neighbor.workUnitId}`,
          identity: neighbor.identity,
        });
      }
      topologyRecords.push({
        type: neighbor.scope === 'release' ? 'release_neighbor' : 'outside_neighbor',
        sourceId: workUnitId,
        targetId: neighbor.workUnitId,
      });
    }
    return {
      fixture_key: `unit:${workUnitId}`,
      identity,
      canvas_role: unit.canvas_role,
      confidence: copyJson(unit.confidence),
      ...(unit.opportunity === undefined ? {} : { opportunity: copyJson(unit.opportunity) }),
      provenance: copyJson(unit.provenance),
      geometry: copyJson(unit.geometry),
      neighbors: localNeighbors,
      external_neighbors: externalNeighbors,
      protected_group: membershipByUnitId.get(workUnitId) || null,
    };
  });

  const fixtureProperties = requireArray(rawTile.properties || [], `${field}.properties`).map((property, index) => {
    const propertyField = `${field}.properties[${index}]`;
    assertAllowedKeys(property, new Set(['fk_property_id', 'property_key', 'work_unit_identity', 'point', 'property_type', 'canvass_eligibility', 'confidence', 'door_count', 'normalized_address', 'display_address', 'building_linkage', 'road_linkage', 'provenance']), propertyField);
    const propertyKey = requireString(property.property_key, `${propertyField}.property_key`);
    const propertyId = canonicalPropertyId(propertyKey);
    const workUnitId = canonicalWorkUnitId(canonicalWorkUnitDescriptor(property.work_unit_identity));
    if (!unitById.has(workUnitId)) fail('property_work_unit_missing', `${propertyField} references a work unit outside its tile.`, { property_id: propertyId });
    validateUnitProvenance(property, propertyField, context.sourceById, context.generatedAt);
    topologyRecords.push({ type: 'property', propertyId });
    return {
      fixture_key: propertyKey,
      fk_property_id: property.fk_property_id,
      property_key: propertyKey,
      work_unit: `unit:${workUnitId}`,
      point: validatePointWithinTile(property.point, tileBounds, `${propertyField}.point`),
      property_type: property.property_type,
      canvass_eligibility: property.canvass_eligibility,
      confidence: copyJson(property.confidence),
      door_count: property.door_count,
      ...(property.normalized_address === undefined ? {} : { normalized_address: requireString(property.normalized_address, `${propertyField}.normalized_address`) }),
      ...(property.display_address === undefined ? {} : { display_address: requireString(property.display_address, `${propertyField}.display_address`) }),
      building_linkage: copyJson(property.building_linkage || []),
      road_linkage: copyJson(property.road_linkage || { work_unit_identity: property.work_unit_identity, method: 'legacy' }),
      provenance: copyJson(property.provenance),
    };
  });
  if (new Set(fixtureProperties.map((property) => property.property_key)).size !== fixtureProperties.length) fail('duplicate_property', `${field}.properties contains duplicate property_key values.`, { field });

  const fixtureTile = {
    tile_address: tileAddress,
    coverage,
    external_neighbors: [...externalById.values()],
    protected_groups: fixtureGroups,
    work_units: fixtureUnits,
    properties: fixtureProperties,
  };
  const compiled = compileCanvasEvidenceTile(fixtureTile, context.releaseId, context.limits);
  return { ...compiled, topologyRecords };
}

function bucketFor(key, bucketCount) {
  const workUnitPrefixes = [...key.matchAll(/cewu1_([a-f0-9]{8})/g)].map((match) => Number.parseInt(match[1], 16));
  if (workUnitPrefixes.length === 1) return workUnitPrefixes[0] % bucketCount;
  if (workUnitPrefixes.length >= 2) {
    const mixed = (workUnitPrefixes[0] ^ ((workUnitPrefixes[1] << 13) | (workUnitPrefixes[1] >>> 19))) >>> 0;
    return mixed % bucketCount;
  }
  return Number.parseInt(sha256Hex(key).slice(0, 8), 16) % bucketCount;
}

class TopologySpool {
  constructor(directory, { bucketCount = DEFAULT_TOPOLOGY_BUCKETS, bufferBytes = DEFAULT_SPOOL_BUFFER_BYTES } = {}) {
    if (!Number.isSafeInteger(bucketCount) || bucketCount < 1 || bucketCount > 4096) {
      fail('invalid_topology_bucket_count', 'Topology bucket count must be an integer from 1 through 4096.');
    }
    this.directory = directory;
    this.bucketCount = bucketCount;
    this.bufferBytesLimit = bufferBytes;
    this.buffers = new Map();
    this.bufferedBytes = 0;
  }

  add(bucketKey, line) {
    const bucket = bucketFor(bucketKey, this.bucketCount);
    const buffered = this.buffers.get(bucket) || [];
    buffered.push(line);
    this.buffers.set(bucket, buffered);
    this.bufferedBytes += Buffer.byteLength(line);
  }

  addRecords(records) {
    for (const record of records) {
      if (record.type === 'unit') {
        this.add(`target:${record.workUnitId}`, `U\t${record.workUnitId}\n`);
        continue;
      }
      if (record.type === 'property') {
        this.add(`property:${record.propertyId}`, `P\t${record.propertyId}\n`);
        continue;
      }
      const prefix = record.type === 'release_neighbor' ? 'R' : 'O';
      this.add(`target:${record.targetId}`, `${prefix}\t${record.targetId}\t${record.sourceId}\n`);
      if (record.type === 'release_neighbor') {
        const [lower, upper] = [record.sourceId, record.targetId].sort();
        const direction = record.sourceId === lower ? 'L' : 'H';
        this.add(`edge:${lower}\u0000${upper}`, `E\t${lower}\t${upper}\t${direction}\n`);
      }
    }
  }

  async flush() {
    if (this.bufferedBytes === 0) return;
    await mkdir(this.directory, { recursive: true });
    for (const [bucket, lines] of this.buffers) {
      await appendFile(join(this.directory, `${String(bucket).padStart(4, '0')}.tsv`), lines.join(''), 'utf8');
    }
    this.buffers.clear();
    this.bufferedBytes = 0;
  }

  async flushIfNeeded() {
    if (this.bufferedBytes >= this.bufferBytesLimit) await this.flush();
  }

  async validate() {
    await this.flush();
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.tsv')).sort();
    let workUnitCount = 0;
    let propertyCount = 0;
    let releaseEdgeCount = 0;
    let outsideEdgeCount = 0;
    let firstAsymmetricEdge = null;
    for (const file of files) {
      const units = new Set();
      const properties = new Set();
      const requiredTargets = new Map();
      const outsideTargets = new Map();
      const edgeMasks = new Map();
      const lines = createInterface({ input: createReadStream(join(this.directory, file), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        const parts = line.split('\t');
        if (parts[0] === 'U') {
          if (units.has(parts[1])) fail('duplicate_release_work_unit', `Work unit ${parts[1]} appears in more than one normalized tile.`, { work_unit_id: parts[1] });
          units.add(parts[1]);
          workUnitCount += 1;
        } else if (parts[0] === 'P') {
          if (properties.has(parts[1])) fail('duplicate_release_property', `Property ${parts[1]} appears in more than one normalized tile.`, { property_id: parts[1] });
          properties.add(parts[1]);
          propertyCount += 1;
        } else if (parts[0] === 'R') {
          requiredTargets.set(parts[1], parts[2]);
          releaseEdgeCount += 1;
        } else if (parts[0] === 'O') {
          outsideTargets.set(parts[1], parts[2]);
          outsideEdgeCount += 1;
        } else if (parts[0] === 'E') {
          const pair = `${parts[1]}\u0000${parts[2]}`;
          const bit = parts[3] === 'L' ? 1 : 2;
          const prior = edgeMasks.get(pair) || 0;
          if ((prior & bit) !== 0) fail('duplicate_topology_edge', 'A release neighbor direction is declared more than once.', { work_unit_id: parts[1], neighbor_id: parts[2] });
          edgeMasks.set(pair, prior | bit);
        } else {
          fail('invalid_topology_spool', 'The temporary topology validation spool is corrupt.', { file });
        }
      }
      for (const [targetId, sourceId] of requiredTargets) {
        if (!units.has(targetId)) {
          fail('missing_release_neighbor', 'A release-scoped neighbor is absent from all input tiles.', { work_unit_id: sourceId, neighbor_id: targetId });
        }
      }
      for (const [targetId, sourceId] of outsideTargets) {
        if (units.has(targetId)) {
          fail('outside_release_neighbor_is_internal', 'An outside_release neighbor is present in this release.', { work_unit_id: sourceId, neighbor_id: targetId });
        }
      }
      for (const [pair, mask] of edgeMasks) {
        if (mask !== 3 && !firstAsymmetricEdge) {
          const [left, right] = pair.split('\u0000');
          firstAsymmetricEdge = { work_unit_id: left, neighbor_id: right };
        }
      }
    }
    if (firstAsymmetricEdge) {
      fail('asymmetric_release_topology', 'Release-scoped neighbor links must be symmetric across tile boundaries.', firstAsymmetricEdge);
    }
    return Object.freeze({ work_unit_count: workUnitCount, property_count: propertyCount, release_neighbor_references: releaseEdgeCount, outside_neighbor_references: outsideEdgeCount });
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectInputFiles(inputPaths) {
  const files = [];
  const visited = new Set();
  async function visit(path) {
    const absolute = resolve(path);
    const info = await lstat(absolute).catch((error) => {
      fail('input_path_unavailable', `Evidence input path is unavailable: ${absolute}`, { path: absolute, cause: error.message });
    });
    if (info.isSymbolicLink()) fail('input_symlink_forbidden', `Evidence inputs must not be symbolic links: ${absolute}`, { path: absolute });
    const canonicalPath = await realpath(absolute);
    if (info.isDirectory()) {
      if (visited.has(canonicalPath)) return;
      visited.add(canonicalPath);
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) await visit(join(absolute, entry.name));
      return;
    }
    if (!info.isFile() || !INPUT_EXTENSIONS.has(extname(absolute).toLowerCase())) return;
    if (visited.has(canonicalPath)) fail('duplicate_input_file', `Evidence input file was selected more than once: ${absolute}`, { path: absolute });
    visited.add(canonicalPath);
    files.push(absolute);
  }
  for (const inputPath of inputPaths) await visit(inputPath);
  files.sort();
  if (files.length === 0) fail('missing_tile_inputs', 'No .json, .jsonl, or .ndjson evidence tile inputs were found.');
  return files;
}

async function* readTilesFromFile(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.ndjson' || extension === '.jsonl') {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) {
        fail('normalized_tile_too_large', `NDJSON tile exceeds the ${MAX_NDJSON_LINE_BYTES}-byte input safety limit.`, { path, line: lineNumber });
      }
      try {
        yield { tile: JSON.parse(line), field: `${path}:${lineNumber}` };
      } catch (error) {
        fail('invalid_normalized_json', `Invalid JSON in ${path} at line ${lineNumber}.`, { path, line: lineNumber, cause: error.message });
      }
    }
    return;
  }
  const info = await stat(path);
  if (info.size > MAX_JSON_INPUT_BYTES) {
    fail('normalized_json_file_too_large', 'Large tile collections must use NDJSON so they can be streamed.', { path, byte_length: info.size, limit: MAX_JSON_INPUT_BYTES });
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail('invalid_normalized_json', `Invalid JSON in ${path}.`, { path, cause: error.message });
  }
  const tiles = Array.isArray(parsed) ? parsed : [parsed];
  for (const [index, tile] of tiles.entries()) yield { tile, field: Array.isArray(parsed) ? `${path}[${index}]` : path };
}

async function atomicWrite(path, bytes, { resume = false } = {}) {
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (resume && await pathExists(path)) {
    const current = await readFile(path);
    if (current.equals(expected)) return false;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryReady = false;
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(expected);
      await handle.sync();
    } finally {
      await handle.close();
    }
    temporaryReady = true;
    await rename(temporary, path);
  } catch (error) {
    if (temporaryReady && process.platform === 'win32' && ['EEXIST', 'EPERM'].includes(error.code) && resume) {
      await rm(path, { force: true });
      await rename(temporary, path);
    } else {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return true;
}

async function removeInterruptedStagingWrites(stagingDirectory) {
  const temporaryPattern = /^\..+\.\d+\.[0-9a-f-]{36}\.tmp$/;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('staging_artifact_invalid', 'Canvas evidence staging must not contain symbolic links.', { path });
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && temporaryPattern.test(entry.name)) await rm(path, { force: true });
    }
  }
  await visit(stagingDirectory);
}

async function readRegularArtifact(path, description) {
  const info = await lstat(path).catch((error) => {
    fail('release_artifact_missing', `${description} is missing.`, { path, cause: error.message });
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('release_artifact_invalid', `${description} must be a regular file, not a link or directory.`, { path });
  }
  return readFile(path);
}

async function collectReleaseFiles(directory) {
  const result = [];
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('release_artifact_invalid', 'Release directories must not contain symbolic links.', { path });
      if (entry.isDirectory()) await visit(path, relativePath);
      else if (entry.isFile()) result.push(relativePath);
      else fail('release_artifact_invalid', 'Release directories may contain only regular files and directories.', { path });
    }
  }
  await visit(directory, '');
  return result.sort();
}

function normalizeObjectPrefix(prefix, releaseId) {
  const raw = prefix === undefined ? 'canvas-evidence/releases' : requireString(prefix, 'object_prefix');
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (
    !normalized
    || normalized.length > 512
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail('invalid_object_prefix', 'Object prefix must be a relative R2/S3 key prefix without dot segments.');
  }
  return `${normalized}/${releaseId}`;
}

function artifactRecord(path, bytes, objectPrefix) {
  return {
    path,
    object_key: `${objectPrefix}/${path}`,
    sha256: sha256Hex(bytes),
    byte_length: bytes.byteLength,
    content_type: 'application/json',
    cache_control: IMMUTABLE_CACHE_CONTROL,
  };
}

function createUploadMetadata({ manifest, manifestBytes, tileArtifacts, publicKeySha256, objectPrefix }) {
  const artifacts = [artifactRecord('manifest.json', manifestBytes, objectPrefix), ...tileArtifacts]
    .sort((left, right) => left.path.localeCompare(right.path));
  const inventory = {
    schema: UPLOAD_INVENTORY_SCHEMA,
    schema_version: 1,
    release_id: manifest.release.release_id,
    object_prefix: objectPrefix,
    signing: {
      algorithm: manifest.signature.algorithm,
      key_id: manifest.signature.key_id,
      public_key_sha256: publicKeySha256,
    },
    artifacts,
  };
  const inventoryBytes = Buffer.from(canonicalStringify(inventory), 'utf8');
  const checksumEntries = [
    ...artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    { path: 'upload-inventory.json', sha256: sha256Hex(inventoryBytes) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const checksumsBytes = Buffer.from(checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(''), 'utf8');
  return { inventory, inventoryBytes, checksumsBytes };
}

async function listTileArtifactNames(directory) {
  const tileDirectory = join(directory, 'tiles');
  if (!await pathExists(tileDirectory)) return [];
  return (await readdir(tileDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function verifyReleaseDirectory({ directory, expectedManifest, publicKey, keyId, expectedInventoryBytes, expectedChecksumsBytes }) {
  const directoryInfo = await lstat(directory).catch((error) => {
    fail('release_artifact_missing', 'Release directory is missing.', { directory, cause: error.message });
  });
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    fail('release_artifact_invalid', 'Release path must be a regular directory.', { directory });
  }
  const manifestFileBytes = await readRegularArtifact(join(directory, 'manifest.json'), 'Release manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestFileBytes.toString('utf8'));
  } catch (error) {
    fail('release_artifact_invalid', 'Release manifest is not valid JSON.', { directory, cause: error.message });
  }
  const canonicalManifestBytes = Buffer.from(canonicalStringify(manifest), 'utf8');
  if (!manifestFileBytes.equals(canonicalManifestBytes)) fail('release_artifact_not_canonical', 'Release manifest is not canonical JSON.', { directory });
  if (!verifyCanvasEvidenceManifest(manifest, { publicKey, expectedKeyId: keyId })) {
    fail('release_signature_invalid', 'Release manifest signature verification failed.', { directory });
  }
  if (!compareCanonical(manifest, expectedManifest)) {
    fail('immutable_release_conflict', 'An existing release directory has the same release ID but different signed content. Use a new dataset version or generated_at value.', { directory });
  }
  const expectedNames = manifest.tiles.map((entry) => `${entry.tile_id}.json`).sort();
  const actualNames = await listTileArtifactNames(directory);
  if (!compareCanonical(actualNames, expectedNames)) {
    fail('release_tile_inventory_mismatch', 'Release tile files do not exactly match the signed manifest.', { directory });
  }
  const expectedFiles = [
    'SHA256SUMS',
    'manifest.json',
    'upload-inventory.json',
    ...expectedNames.map((name) => `tiles/${name}`),
  ].sort();
  const actualFiles = await collectReleaseFiles(directory);
  if (!compareCanonical(actualFiles, expectedFiles)) {
    fail('release_artifact_inventory_mismatch', 'Release directory contains missing or unlisted artifacts.', { directory });
  }
  for (const entry of manifest.tiles) {
    const path = join(directory, ...entry.uri.split('/'));
    const bytes = await readRegularArtifact(path, `Signed tile ${entry.tile_id}`);
    if (bytes.byteLength > manifest.limits.max_tile_bytes) fail('release_tile_too_large', `Signed tile ${entry.tile_id} exceeds its release limit.`, { path });
    let tile;
    try {
      tile = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      fail('release_artifact_invalid', `Signed tile ${entry.tile_id} is not valid JSON.`, { path, cause: error.message });
    }
    const canonicalBytes = Buffer.from(canonicalStringify(tile), 'utf8');
    if (!bytes.equals(canonicalBytes)) fail('release_artifact_not_canonical', `Signed tile ${entry.tile_id} is not canonical JSON.`, { path });
    const metrics = validateCanvasEvidenceTile(tile, manifest.limits);
    if (
      tile.release_id !== manifest.release.release_id
      || sha256Hex(bytes) !== entry.sha256
      || bytes.byteLength !== entry.byte_length
      || metrics.work_unit_count !== entry.work_unit_count
      || metrics.property_count !== entry.property_count
      || metrics.expected_opportunities !== entry.expected_opportunities
      || tile.coverage.area_sq_mi !== entry.coverage_area_sq_mi
      || !compareCanonical(tile.coverage.bounds, entry.coverage_bounds)
    ) {
      fail('release_tile_manifest_mismatch', `Signed tile ${entry.tile_id} does not match its manifest entry.`, { path });
    }
  }
  const inventoryBytes = await readRegularArtifact(join(directory, 'upload-inventory.json'), 'Upload inventory');
  const checksumsBytes = await readRegularArtifact(join(directory, 'SHA256SUMS'), 'SHA256SUMS');
  if (!inventoryBytes.equals(expectedInventoryBytes) || !checksumsBytes.equals(expectedChecksumsBytes)) {
    fail('immutable_release_conflict', 'Existing release upload metadata differs from the requested release.', { directory });
  }
  return Object.freeze({ release_id: manifest.release.release_id, tile_count: manifest.tiles.length });
}

function safeStagingPath(outputRoot, releaseId) {
  const root = resolve(outputRoot);
  const staging = resolve(root, `.canvas-evidence-${releaseId}.staging`);
  if (dirname(staging) !== root || !basename(staging).startsWith('.canvas-evidence-cer1_')) {
    fail('unsafe_staging_path', 'Refusing to use an unsafe release staging path.', { staging });
  }
  return { root, staging, final: join(root, releaseId) };
}

export async function buildCanvasEvidenceRelease({
  releaseMetadata,
  tileInputPaths = [],
  inputBaseDirectory = process.cwd(),
  outputRoot,
  privateKey,
  publicKey,
  keyId,
  objectPrefix,
  validateOnly = false,
  resume = false,
  topologyBucketCount = DEFAULT_TOPOLOGY_BUCKETS,
  topologySpoolRoot = tmpdir(),
} = {}) {
  if (resume && validateOnly) fail('invalid_build_mode', '--resume cannot be combined with --validate-only.');
  const metadata = normalizedReleaseMetadata(releaseMetadata);
  const configuredInputs = metadata.tileInputs.map((path) => resolve(inputBaseDirectory, path));
  const explicitInputs = tileInputPaths.map((path) => resolve(path));
  const inputFiles = await collectInputFiles(explicitInputs.length > 0 ? explicitInputs : configuredInputs);
  const signing = validateOnly && privateKey === undefined
    ? null
    : resolveProductionSigningMaterial({ privateKey, publicKey, keyId });
  if (!validateOnly && !outputRoot) fail('missing_output_root', 'A production release build requires outputRoot.');

  const paths = validateOnly ? null : safeStagingPath(outputRoot, metadata.releaseId);
  let existingFinal = false;
  if (paths) {
    await mkdir(paths.root, { recursive: true });
    existingFinal = await pathExists(paths.final);
    if (existingFinal && !resume) {
      fail('release_already_exists', `Immutable release ${metadata.releaseId} already exists. Use --resume only to verify identical output.`, { directory: paths.final });
    }
    if (!existingFinal) {
      const stageExists = await pathExists(paths.staging);
      if (stageExists && !resume) {
        fail('staging_release_exists', `A staging directory already exists for ${metadata.releaseId}. Use --resume to continue it.`, { directory: paths.staging });
      }
      await mkdir(join(paths.staging, 'tiles'), { recursive: true });
      if (stageExists && resume) await removeInterruptedStagingWrites(paths.staging);
    }
  }

  const spoolDirectory = await mkdtemp(join(resolve(topologySpoolRoot), 'firstknock-canvas-topology-'));
  const topologySpool = new TopologySpool(spoolDirectory, { bucketCount: topologyBucketCount });
  const manifestEntries = [];
  const tileArtifacts = [];
  const releaseObjectPrefix = validateOnly ? null : normalizeObjectPrefix(objectPrefix, metadata.releaseId);
  const seenTileIds = new Set();
  let tileCount = 0;
  try {
    for (const inputFile of inputFiles) {
      const inputBefore = await stat(inputFile);
      for await (const { tile: normalizedTile, field } of readTilesFromFile(inputFile)) {
        const compiled = compileNormalizedCanvasEvidenceTile(normalizedTile, {
          field,
          releaseId: metadata.releaseId,
          limits: metadata.limits,
          tileScheme: metadata.tile_scheme,
          releaseCoverage: metadata.coverage,
          sourceById: metadata.sourceById,
          generatedAt: metadata.release.generated_at,
        });
        if (seenTileIds.has(compiled.tile.tile_id)) {
          fail('duplicate_release_tile', `Tile ${compiled.tile.tile_id} appears more than once.`, { tile_id: compiled.tile.tile_id });
        }
        seenTileIds.add(compiled.tile.tile_id);
        tileCount += 1;
        if (tileCount > metadata.limits.max_tiles_per_release) {
          fail('release_tile_limit_exceeded', 'Normalized inputs exceed the signed release tile limit.', { limit: metadata.limits.max_tiles_per_release });
        }
        const bytes = Buffer.from(canonicalStringify(compiled.tile), 'utf8');
        manifestEntries.push(compiled.manifestEntry);
        topologySpool.addRecords(compiled.topologyRecords);
        await topologySpool.flushIfNeeded();
        const artifactPath = `tiles/${compiled.tile.tile_id}.json`;
        if (!validateOnly) tileArtifacts.push(artifactRecord(artifactPath, bytes, releaseObjectPrefix));
        if (paths && !existingFinal) {
          await atomicWrite(join(paths.staging, ...artifactPath.split('/')), bytes, { resume });
        }
      }
      const inputAfter = await stat(inputFile);
      if (
        inputBefore.size !== inputAfter.size
        || inputBefore.mtimeMs !== inputAfter.mtimeMs
        || (inputBefore.ino && inputAfter.ino && inputBefore.ino !== inputAfter.ino)
      ) {
        fail('input_changed_during_build', 'A normalized evidence input changed while the release was being compiled.', { path: inputFile });
      }
    }
    if (tileCount === 0) fail('missing_normalized_tiles', 'Normalized evidence inputs did not contain any tiles.');
    const topology = await topologySpool.validate();
    manifestEntries.sort((left, right) => left.tile_id.localeCompare(right.tile_id));
    tileArtifacts.sort((left, right) => left.path.localeCompare(right.path));
    const unsigned = {
      schema: metadata.schema,
      schema_version: metadata.schema_version,
      release: metadata.release,
      coverage: metadata.coverage,
      tile_scheme: metadata.tile_scheme,
      limits: metadata.limits,
      sources: metadata.sources,
      tiles: manifestEntries,
    };
    validateCanvasEvidenceManifest(unsigned, { requireSignature: false });
    if (validateOnly && !signing) {
      return Object.freeze({
        mode: 'validate-only',
        release_id: metadata.releaseId,
        tile_count: tileCount,
        work_unit_count: topology.work_unit_count,
        topology,
        input_files: inputFiles.length,
        signed: false,
      });
    }
    const manifest = signCanvasEvidenceManifest(unsigned, { privateKey: signing.privateKey, keyId: signing.keyId });
    if (!verifyCanvasEvidenceManifest(manifest, { publicKey: signing.publicKey, expectedKeyId: signing.keyId })) {
      fail('release_signature_invalid', 'The newly signed manifest did not verify with the supplied public key.');
    }
    if (validateOnly) {
      return Object.freeze({
        mode: 'validate-only',
        release_id: metadata.releaseId,
        tile_count: tileCount,
        work_unit_count: topology.work_unit_count,
        topology,
        input_files: inputFiles.length,
        signed: true,
        public_key_sha256: signing.publicKeySha256,
      });
    }
    const manifestBytes = Buffer.from(canonicalStringify(manifest), 'utf8');
    const upload = createUploadMetadata({
      manifest,
      manifestBytes,
      tileArtifacts,
      publicKeySha256: signing.publicKeySha256,
      objectPrefix: releaseObjectPrefix,
    });
    if (existingFinal) {
      await verifyReleaseDirectory({
        directory: paths.final,
        expectedManifest: manifest,
        publicKey: signing.publicKey,
        keyId: signing.keyId,
        expectedInventoryBytes: upload.inventoryBytes,
        expectedChecksumsBytes: upload.checksumsBytes,
      });
      return Object.freeze({
        mode: 'resume',
        resumed: true,
        release_id: metadata.releaseId,
        release_directory: paths.final,
        manifest_path: join(paths.final, 'manifest.json'),
        tile_count: tileCount,
        work_unit_count: topology.work_unit_count,
        topology,
        public_key_sha256: signing.publicKeySha256,
      });
    }
    const actualTileNames = await listTileArtifactNames(paths.staging);
    const expectedTileNames = manifest.tiles.map((entry) => `${entry.tile_id}.json`).sort();
    if (!compareCanonical(actualTileNames, expectedTileNames)) {
      fail('staging_tile_inventory_mismatch', 'Staging contains tiles that do not exactly match the requested immutable release.', { directory: paths.staging });
    }
    await atomicWrite(join(paths.staging, 'manifest.json'), manifestBytes, { resume });
    await atomicWrite(join(paths.staging, 'upload-inventory.json'), upload.inventoryBytes, { resume });
    await atomicWrite(join(paths.staging, 'SHA256SUMS'), upload.checksumsBytes, { resume });
    await verifyReleaseDirectory({
      directory: paths.staging,
      expectedManifest: manifest,
      publicKey: signing.publicKey,
      keyId: signing.keyId,
      expectedInventoryBytes: upload.inventoryBytes,
      expectedChecksumsBytes: upload.checksumsBytes,
    });
    try {
      await rename(paths.staging, paths.final);
    } catch (error) {
      if (await pathExists(paths.final)) {
        fail('release_publish_race', `Another process published ${metadata.releaseId} first. Re-run with --resume to verify it.`, { directory: paths.final });
      }
      throw error;
    }
    return Object.freeze({
      mode: 'build',
      resumed: false,
      release_id: metadata.releaseId,
      release_directory: paths.final,
      manifest_path: join(paths.final, 'manifest.json'),
      tile_count: tileCount,
      work_unit_count: topology.work_unit_count,
      topology,
      public_key_sha256: signing.publicKeySha256,
    });
  } finally {
    await rm(spoolDirectory, { recursive: true, force: true });
  }
}

export async function loadReleaseMetadata(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail('invalid_release_metadata_file', `Release metadata could not be read as JSON: ${path}`, { path, cause: error.message });
  }
}

export async function loadSigningKeysFromFiles({ privateKeyPath, publicKeyPath, keyId }) {
  const privateKey = await readFile(privateKeyPath, 'utf8').catch((error) => {
    fail('private_key_file_unavailable', 'Evidence signing private-key file is unavailable.', { path: privateKeyPath, cause: error.message });
  });
  const publicKey = publicKeyPath
    ? await readFile(publicKeyPath, 'utf8').catch((error) => {
      fail('public_key_file_unavailable', 'Evidence verification public-key file is unavailable.', { path: publicKeyPath, cause: error.message });
    })
    : undefined;
  return { privateKey, publicKey, keyId };
}