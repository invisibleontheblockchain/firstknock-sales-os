import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { canonicalStringify, parseJsonBytes, readBoundedBytes, sha256Hex } from './canonical.mjs';
import { connectivityContextBounds, selectBoundaryConnectivity } from './connectivity-selection.mjs';
import { boundsIntersect, polygonBounds, stitchSelections } from './geometry.mjs';
import { ServiceError } from './errors.mjs';

const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_TILE_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_TILE_BYTES = 5_500_000;
const RELEASE_PATTERN = /^cer1_[a-f0-9]{64}$/;
const TILE_PATTERN = /^cet1_[a-f0-9]{64}$/;
const WORK_UNIT_PATTERN = /^cewu1_[a-f0-9]{64}$/;
const PROPERTY_PATTERN = /^cepr1_[a-f0-9]{64}$/;
const ROLES = new Set(['opportunity', 'transit', 'uncertain', 'excluded']);
const INDEX_DEGREES = 2;

function buildTileIndex(tiles) {
  const index = new Map();
  for (const tile of tiles) {
    const bounds = tile.coverage_bounds;
    const minLng = Math.floor((bounds.min_lng + 180) / INDEX_DEGREES);
    const maxLng = Math.floor((bounds.max_lng + 180) / INDEX_DEGREES);
    const minLat = Math.floor((bounds.min_lat + 90) / INDEX_DEGREES);
    const maxLat = Math.floor((bounds.max_lat + 90) / INDEX_DEGREES);
    for (let lng = minLng; lng <= maxLng; lng += 1) {
      for (let lat = minLat; lat <= maxLat; lat += 1) {
        const key = `${lng}:${lat}`;
        const values = index.get(key) || [];
        values.push(tile);
        index.set(key, values);
      }
    }
  }
  return index;
}

function indexedCandidates(index, bounds) {
  const candidates = new Map();
  const minLng = Math.floor((bounds.min_lng + 180) / INDEX_DEGREES);
  const maxLng = Math.floor((bounds.max_lng + 180) / INDEX_DEGREES);
  const minLat = Math.floor((bounds.min_lat + 90) / INDEX_DEGREES);
  const maxLat = Math.floor((bounds.max_lat + 90) / INDEX_DEGREES);
  for (let lng = minLng; lng <= maxLng; lng += 1) {
    for (let lat = minLat; lat <= maxLat; lat += 1) {
      for (const tile of index.get(`${lng}:${lat}`) || []) candidates.set(tile.tile_id, tile);
    }
  }
  return [...candidates.values()];
}

function unsignedManifest(manifest) {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function requiredString(value, field, pattern = null, maxLength = 512) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > maxLength || (pattern && !pattern.test(value))) {
    throw new ServiceError(502, 'evidence_contract_invalid', `${field} is invalid.`);
  }
  return value;
}

function publicKey(value) {
  const normalized = String(value || '').replaceAll('\\n', '\n').trim();
  if (!normalized) throw new ServiceError(503, 'evidence_key_missing', 'Canvas evidence verification key is not configured.');
  try {
    if (normalized.includes('BEGIN PUBLIC KEY')) return createPublicKey(normalized);
    return createPublicKey({ key: Buffer.from(normalized, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new ServiceError(503, 'evidence_key_invalid', 'Canvas evidence verification key is invalid.');
  }
}

function validateBounds(bounds, field) {
  if (!bounds || typeof bounds !== 'object') throw new ServiceError(502, 'evidence_contract_invalid', `${field} is missing.`);
  for (const key of ['min_lng', 'max_lng', 'min_lat', 'max_lat']) {
    if (!Number.isFinite(bounds[key])) throw new ServiceError(502, 'evidence_contract_invalid', `${field}.${key} is invalid.`);
  }
  if (bounds.min_lng >= bounds.max_lng || bounds.min_lat >= bounds.max_lat) throw new ServiceError(502, 'evidence_contract_invalid', `${field} is empty.`);
}

function verifyManifest(manifest, key, expectedKeyId) {
  if (manifest?.schema !== 'firstknock.canvas-evidence-manifest' || manifest?.schema_version !== 1) {
    throw new ServiceError(502, 'evidence_manifest_schema_invalid', 'Canvas evidence manifest schema is unsupported.');
  }
  requiredString(manifest.release?.release_id, 'release ID', RELEASE_PATTERN, 72);
  requiredString(manifest.release?.dataset_namespace, 'dataset namespace', null, 128);
  requiredString(manifest.release?.dataset_version, 'dataset version', null, 128);
  requiredString(manifest.release?.compiler_version, 'compiler version', null, 128);
  if (!manifest.tile_scheme || typeof manifest.tile_scheme !== 'object') throw new ServiceError(502, 'evidence_contract_invalid', 'Canvas evidence tile scheme is missing.');
  requiredString(manifest.tile_scheme.scheme, 'tile scheme', /^[a-z][a-z0-9.-]{0,63}$/, 64);
  if (!Number.isInteger(manifest.tile_scheme.scheme_version) || manifest.tile_scheme.scheme_version < 1) throw new ServiceError(502, 'evidence_contract_invalid', 'Canvas evidence tile scheme version is invalid.');
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 1) throw new ServiceError(502, 'evidence_contract_invalid', 'Canvas evidence sources are missing.');
  for (const [index, source] of manifest.sources.entries()) {
    requiredString(source.source_id, `sources[${index}].source_id`, /^[a-z][a-z0-9._-]{0,127}$/, 128);
    requiredString(source.dataset_version, `sources[${index}].dataset_version`, null, 128);
    requiredString(source.license, `sources[${index}].license`, null, 256);
  }
  if (manifest.signature?.algorithm !== 'Ed25519' || manifest.signature?.key_id !== expectedKeyId) {
    throw new ServiceError(502, 'evidence_manifest_signature_invalid', 'Canvas evidence manifest uses an unexpected signing key.');
  }
  requiredString(manifest.signature?.value, 'manifest signature', /^[A-Za-z0-9_-]{86}$/, 86);
  const valid = verifySignature(
    null,
    Buffer.from(canonicalStringify(unsignedManifest(manifest)), 'utf8'),
    key,
    Buffer.from(manifest.signature.value, 'base64url'),
  );
  if (!valid) throw new ServiceError(502, 'evidence_manifest_signature_invalid', 'Canvas evidence manifest signature verification failed.');
  if (!Array.isArray(manifest.tiles) || manifest.tiles.length < 1) throw new ServiceError(502, 'evidence_contract_invalid', 'Canvas evidence manifest contains no tiles.');
  const tileIds = new Set();
  for (const [index, tile] of manifest.tiles.entries()) {
    requiredString(tile.tile_id, `tiles[${index}].tile_id`, TILE_PATTERN, 72);
    if (tileIds.has(tile.tile_id)) throw new ServiceError(502, 'evidence_contract_invalid', 'Canvas evidence manifest contains duplicate tiles.');
    tileIds.add(tile.tile_id);
    requiredString(tile.uri, `tiles[${index}].uri`, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, 512);
    requiredString(tile.sha256, `tiles[${index}].sha256`, /^[a-f0-9]{64}$/, 64);
    if (!Number.isInteger(tile.byte_length) || tile.byte_length < 1 || tile.byte_length > MAX_TILE_BYTES) throw new ServiceError(502, 'evidence_contract_invalid', 'Canvas evidence tile byte length is invalid.');
    validateBounds(tile.coverage_bounds, `tiles[${index}].coverage_bounds`);
  }
  return manifest;
}

function validateTile(tile, entry, releaseId) {
  if (tile?.schema !== 'firstknock.canvas-evidence-tile' || tile?.schema_version !== 1
    || tile.tile_id !== entry.tile_id || tile.release_id !== releaseId) {
    throw new ServiceError(502, 'evidence_tile_identity_invalid', `Canvas evidence tile ${entry.tile_id} has an invalid identity.`);
  }
  if (!Array.isArray(tile.work_units) || !Array.isArray(tile.protected_groups) || !Array.isArray(tile.external_neighbor_ids)) {
    throw new ServiceError(502, 'evidence_tile_schema_invalid', `Canvas evidence tile ${entry.tile_id} is incomplete.`);
  }
  const ids = new Set();
  const unitsById = new Map();
  for (const unit of tile.work_units) {
    requiredString(unit.work_unit_id, 'work unit ID', WORK_UNIT_PATTERN, 72);
    if (ids.has(unit.work_unit_id)) throw new ServiceError(502, 'evidence_tile_schema_invalid', 'Canvas evidence tile contains duplicate work units.');
    ids.add(unit.work_unit_id);
    unitsById.set(unit.work_unit_id, unit);
    if (!ROLES.has(unit.canvas_role) || !Array.isArray(unit.neighbor_ids) || !Array.isArray(unit.provenance)
      || !unit.confidence || !Number.isFinite(unit.confidence.score)
      || unit.geometry?.type !== 'LineString' || !Array.isArray(unit.geometry.coordinates) || unit.geometry.coordinates.length < 2) {
      throw new ServiceError(502, 'evidence_tile_schema_invalid', `Work unit ${unit.work_unit_id} is invalid.`);
    }
    if (unit.canvas_role === 'opportunity') {
      const opportunity = unit.opportunity;
      if (!opportunity || ![opportunity.min, opportunity.expected, opportunity.max].every(Number.isFinite)
        || opportunity.min < 0 || opportunity.min > opportunity.expected || opportunity.expected > opportunity.max) {
        throw new ServiceError(502, 'evidence_tile_schema_invalid', `Work unit ${unit.work_unit_id} has an invalid opportunity range.`);
      }
    } else if (unit.opportunity !== null) {
      throw new ServiceError(502, 'evidence_tile_schema_invalid', `Non-opportunity work unit ${unit.work_unit_id} has workload.`);
    }
    if (unit.provenance.length < 1 || unit.confidence.score < 0 || unit.confidence.score > 1) throw new ServiceError(502, 'evidence_tile_schema_invalid', `Work unit ${unit.work_unit_id} has incomplete evidence.`);
    for (const neighborId of unit.neighbor_ids) requiredString(neighborId, 'neighbor ID', WORK_UNIT_PATTERN, 72);
  }
  const properties = tile.properties === undefined ? [] : tile.properties;
  if (!Array.isArray(properties)) throw new ServiceError(502, 'evidence_tile_schema_invalid', `Canvas evidence tile ${entry.tile_id} properties are invalid.`);
  const propertyIds = new Set();
  for (const property of properties) {
    requiredString(property.property_id, 'property ID', PROPERTY_PATTERN, 72);
    requiredString(property.fk_property_id, 'FirstKnock property ID', /^FKP1_[a-f0-9]{64}$/, 69);
    if (propertyIds.has(property.property_id)) throw new ServiceError(502, 'evidence_tile_schema_invalid', 'Canvas evidence tile contains duplicate properties.');
    propertyIds.add(property.property_id);
    requiredString(property.property_key, 'property key', null, 256);
    requiredString(property.work_unit_id, 'property work unit ID', WORK_UNIT_PATTERN, 72);
    if (!ids.has(property.work_unit_id) || !['residential', 'multifamily', 'commercial', 'government', 'institutional', 'vacant', 'unknown'].includes(property.property_type)
      || !['eligible', 'excluded', 'review'].includes(property.canvass_eligibility)
      || !Number.isInteger(property.door_count) || property.door_count < 1
      || !property.confidence || !Number.isFinite(property.confidence.score) || property.confidence.score < 0 || property.confidence.score > 1
      || !Array.isArray(property.confidence.reasons) || !property.confidence.reasons.length
      || !Array.isArray(property.provenance) || !property.provenance.length
      || !Array.isArray(property.building_linkage)
      || !property.road_linkage || typeof property.road_linkage.method !== 'string'
      || !Number.isFinite(property.point?.lat) || !Number.isFinite(property.point?.lng)) {
      throw new ServiceError(502, 'evidence_tile_schema_invalid', `Property ${property.property_id} is invalid.`);
    }
  }
  if (entry.property_count !== undefined && entry.property_count !== properties.length) throw new ServiceError(502, 'evidence_tile_schema_invalid', `Canvas evidence tile ${entry.tile_id} property count differs from its manifest.`);
  if (entry.work_unit_count !== tile.work_units.length) throw new ServiceError(502, 'evidence_tile_schema_invalid', `Canvas evidence tile ${entry.tile_id} work-unit count differs from its manifest.`);
  if (canonicalStringify(tile.coverage?.bounds) !== canonicalStringify(entry.coverage_bounds)) throw new ServiceError(502, 'evidence_tile_schema_invalid', `Canvas evidence tile ${entry.tile_id} bounds differ from its manifest.`);
  const external = new Set(tile.external_neighbor_ids);
  for (const unit of tile.work_units) {
    for (const neighborId of unit.neighbor_ids) {
      if (!ids.has(neighborId) && !external.has(neighborId)) throw new ServiceError(502, 'evidence_topology_invalid', `Work unit ${unit.work_unit_id} references an undeclared neighbor.`);
      if (ids.has(neighborId) && !unitsById.get(neighborId)?.neighbor_ids.includes(unit.work_unit_id)) {
        throw new ServiceError(502, 'evidence_topology_asymmetric', `Work unit ${unit.work_unit_id} has asymmetric local topology.`);
      }
    }
  }
  const grouped = new Map();
  for (const group of tile.protected_groups) {
    requiredString(group.protected_group_id, 'protected group ID', /^cepg1_[a-f0-9]{64}$/, 72);
    if (!Array.isArray(group.member_work_unit_ids) || group.member_work_unit_ids.length < 1) throw new ServiceError(502, 'evidence_protected_group_invalid', 'Canvas evidence protected group is empty.');
    for (const memberId of group.member_work_unit_ids) {
      if (!ids.has(memberId) || grouped.has(memberId)) throw new ServiceError(502, 'evidence_protected_group_invalid', 'Canvas evidence protected group membership is invalid.');
      grouped.set(memberId, group.protected_group_id);
    }
  }
  for (const unit of tile.work_units) {
    if ((grouped.get(unit.work_unit_id) || null) !== unit.protected_group_id) throw new ServiceError(502, 'evidence_protected_group_invalid', `Work unit ${unit.work_unit_id} protected membership disagrees.`);
  }
  return tile;
}

export class EvidenceRepository {
  constructor({
    manifestUrl,
    manifestPublicKey,
    expectedKeyId,
    evidenceBearerToken = null,
    fetchImpl = globalThis.fetch,
    maxManifestBytes = DEFAULT_MAX_MANIFEST_BYTES,
    cacheTtlMs = 300_000,
    fetchTimeoutMs = 30_000,
    tileCacheBytes = DEFAULT_TILE_CACHE_BYTES,
  }) {
    this.manifestUrl = new URL(manifestUrl);
    if (this.manifestUrl.protocol !== 'https:' || this.manifestUrl.username || this.manifestUrl.password) {
      throw new ServiceError(503, 'evidence_manifest_url_invalid', 'Canvas evidence manifest URL must use HTTPS.');
    }
    this.key = publicKey(manifestPublicKey);
    this.expectedKeyId = requiredString(expectedKeyId, 'expected signing key ID', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 128);
    this.evidenceBearerToken = evidenceBearerToken ? String(evidenceBearerToken) : null;
    this.fetchImpl = fetchImpl;
    this.maxManifestBytes = maxManifestBytes;
    this.cacheTtlMs = cacheTtlMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.tileCacheBytes = tileCacheBytes;
    this.cache = null;
    this.tileCache = new Map();
    this.tileCacheSize = 0;
  }

  headers() {
    return {
      accept: 'application/json',
      ...(this.evidenceBearerToken ? { authorization: `Bearer ${this.evidenceBearerToken}` } : {}),
    };
  }

  async fetch(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw new ServiceError(504, 'evidence_fetch_timeout', 'Canvas evidence request timed out.', { retryable: true });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async loadManifest({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.loadedAt < this.cacheTtlMs) return this.cache.release;
    let response;
    try {
      response = await this.fetch(this.manifestUrl, { headers: this.headers(), redirect: 'error' });
    } catch {
      throw new ServiceError(503, 'evidence_manifest_unavailable', 'Canvas evidence manifest is unavailable.', { retryable: true });
    }
    if (!response.ok) throw new ServiceError(503, 'evidence_manifest_unavailable', 'Canvas evidence manifest is unavailable.', { retryable: true });
    const bytes = await readBoundedBytes(response, this.maxManifestBytes, 'Canvas evidence manifest');
    const manifest = verifyManifest(parseJsonBytes(bytes, 'Canvas evidence manifest'), this.key, this.expectedKeyId);
    const manifestHash = sha256Hex(Buffer.from(canonicalStringify(manifest), 'utf8'));
    const providers = [...new Set(manifest.sources.map((source) => String(source.provider || source.source_id || '').trim()).filter(Boolean))];
    const release = Object.freeze({
      manifest,
      manifest_hash: manifestHash,
      release_id: manifest.release.release_id,
      provider: (providers.join(', ') || manifest.release.dataset_namespace).slice(0, 128),
      tile_scheme: `${manifest.tile_scheme.scheme}/${manifest.tile_scheme.scheme_version}`,
      source_versions: Object.fromEntries(manifest.sources.map((source) => [source.source_id, source.dataset_version])),
      source_attribution: manifest.sources.map((source) => `${source.provider || source.source_id} (${source.license})`).join('; ').slice(0, 1_000),
      tile_index: buildTileIndex(manifest.tiles),
    });
    this.cache = { loadedAt: Date.now(), release };
    return release;
  }

  selectTiles(release, polygon) {
    const workloadBounds = polygonBounds(polygon);
    const hasWorkloadCoverage = indexedCandidates(release.tile_index, workloadBounds)
      .some((entry) => boundsIntersect(entry.coverage_bounds, workloadBounds));
    if (!hasWorkloadCoverage) return [];
    const contextBounds = connectivityContextBounds(polygon);
    return indexedCandidates(release.tile_index, contextBounds)
      .filter((entry) => boundsIntersect(entry.coverage_bounds, contextBounds))
      .sort((left, right) => left.tile_id.localeCompare(right.tile_id));
  }

  async loadTile(release, entry) {
    const cacheKey = `${release.manifest_hash}:${entry.tile_id}:${entry.sha256}`;
    const cached = this.tileCache.get(cacheKey);
    if (cached) {
      this.tileCache.delete(cacheKey);
      this.tileCache.set(cacheKey, cached);
      return cached.tile;
    }
    const url = new URL(entry.uri, this.manifestUrl);
    if (url.origin !== this.manifestUrl.origin) throw new ServiceError(502, 'evidence_tile_origin_invalid', 'Canvas evidence tile escaped its signed manifest origin.');
    let response;
    try {
      response = await this.fetch(url, { headers: this.headers(), redirect: 'error' });
    } catch {
      throw new ServiceError(503, 'evidence_tile_unavailable', `Canvas evidence tile ${entry.tile_id} is unavailable.`, { retryable: true });
    }
    if (!response.ok) throw new ServiceError(503, 'evidence_tile_unavailable', `Canvas evidence tile ${entry.tile_id} is unavailable.`, { retryable: true });
    const bytes = await readBoundedBytes(response, Math.min(MAX_TILE_BYTES, entry.byte_length), `Canvas evidence tile ${entry.tile_id}`);
    if (bytes.byteLength !== entry.byte_length || sha256Hex(bytes) !== entry.sha256) {
      throw new ServiceError(502, 'evidence_tile_digest_mismatch', `Canvas evidence tile ${entry.tile_id} failed integrity verification.`);
    }
    const tile = validateTile(parseJsonBytes(bytes, `Canvas evidence tile ${entry.tile_id}`), entry, release.release_id);
    while (this.tileCacheSize + bytes.byteLength > this.tileCacheBytes && this.tileCache.size) {
      const oldestKey = this.tileCache.keys().next().value;
      this.tileCacheSize -= this.tileCache.get(oldestKey).bytes;
      this.tileCache.delete(oldestKey);
    }
    if (bytes.byteLength <= this.tileCacheBytes) {
      this.tileCache.set(cacheKey, { tile, bytes: bytes.byteLength });
      this.tileCacheSize += bytes.byteLength;
    }
    return tile;
  }

  async analyzeBoundary(release, polygon, onProgress = async () => {}, isCancelled = async () => false) {
    const entries = this.selectTiles(release, polygon);
    if (!entries.length) throw new ServiceError(422, 'evidence_coverage_missing', 'No signed Canvas evidence tiles cover this boundary.');
    const contextSelections = [];
    for (let index = 0; index < entries.length; index += 1) {
      if (await isCancelled()) throw new ServiceError(409, 'analysis_cancelled', 'Canvas analysis was cancelled.');
      const tile = await this.loadTile(release, entries[index]);
      contextSelections.push({
        work_units: tile.work_units,
        properties: tile.properties || [],
        protected_groups: tile.protected_groups,
        external_neighbor_ids: tile.external_neighbor_ids,
      });
      await onProgress(index + 1, entries.length);
    }
    const signedContext = stitchSelections(contextSelections);
    return { entries, ...selectBoundaryConnectivity(signedContext, polygon) };
  }
}