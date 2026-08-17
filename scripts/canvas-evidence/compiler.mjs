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
  validateCanvasEvidenceBundle,
  validateCanvasEvidenceTile,
} from './contract.mjs';

function assertRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
  return value;
}

function assertArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`);
  return value;
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueMap(items, keyName, field) {
  const result = new Map();
  for (const item of items) {
    const key = item?.[keyName];
    if (typeof key !== 'string' || key.length === 0) throw new TypeError(`${field}.${keyName} must be a non-empty string.`);
    if (result.has(key)) throw new TypeError(`${field} contains duplicate ${keyName} ${key}.`);
    result.set(key, item);
  }
  return result;
}

function confidenceTier(score) {
  if (score === 0) return 'unknown';
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

export function compileCanvasEvidenceTile(rawTile, releaseId, limits = DEFAULT_CANVAS_EVIDENCE_LIMITS) {
  assertRecord(rawTile, 'fixture.tiles[]');
  const tileAddress = canonicalTileAddress(rawTile.tile_address);
  const tileId = canonicalTileId(tileAddress);
  const rawUnits = assertArray(rawTile.work_units, 'fixture.tiles[].work_units');
  const unitsByKey = uniqueMap(rawUnits, 'fixture_key', 'fixture.tiles[].work_units');
  const workUnitIdsByKey = new Map();

  for (const [fixtureKey, rawUnit] of unitsByKey) {
    workUnitIdsByKey.set(fixtureKey, canonicalWorkUnitId(canonicalWorkUnitDescriptor(rawUnit.identity)));
  }
  const externalUnitsByKey = uniqueMap(rawTile.external_neighbors || [], 'fixture_key', 'fixture.tiles[].external_neighbors');
  const externalWorkUnitIdsByKey = new Map();
  for (const [fixtureKey, externalUnit] of externalUnitsByKey) {
    externalWorkUnitIdsByKey.set(fixtureKey, canonicalWorkUnitId(canonicalWorkUnitDescriptor(externalUnit.identity)));
  }

  const rawGroups = assertArray(rawTile.protected_groups || [], 'fixture.tiles[].protected_groups');
  const groupsByKey = uniqueMap(rawGroups, 'fixture_key', 'fixture.tiles[].protected_groups');
  const groupIdsByKey = new Map();
  const protectedGroups = [];
  for (const [fixtureKey, rawGroup] of groupsByKey) {
    const memberIds = assertArray(rawGroup.members, `protected_groups.${fixtureKey}.members`)
      .map((memberKey) => {
        const id = workUnitIdsByKey.get(memberKey);
        if (!id) throw new TypeError(`Protected group ${fixtureKey} references unknown work unit ${memberKey}.`);
        return id;
      })
      .sort();
    const protectedGroupId = canonicalProtectedGroupId(rawGroup.kind, memberIds);
    groupIdsByKey.set(fixtureKey, protectedGroupId);
    const entryIds = assertArray(rawGroup.entries || [], `protected_groups.${fixtureKey}.entries`)
      .map((entryKey) => {
        const id = workUnitIdsByKey.get(entryKey);
        if (!id) throw new TypeError(`Protected group ${fixtureKey} references unknown entry ${entryKey}.`);
        return id;
      })
      .sort();
    protectedGroups.push({
      protected_group_id: protectedGroupId,
      kind: rawGroup.kind,
      member_work_unit_ids: memberIds,
      entry_work_unit_ids: entryIds,
    });
  }
  protectedGroups.sort((left, right) => left.protected_group_id.localeCompare(right.protected_group_id));

  const workUnits = [];
  for (const [fixtureKey, rawUnit] of unitsByKey) {
    const workUnitId = workUnitIdsByKey.get(fixtureKey);
    const localNeighborIds = assertArray(rawUnit.neighbors || [], `work_units.${fixtureKey}.neighbors`)
      .map((neighborKey) => {
        const id = workUnitIdsByKey.get(neighborKey);
        if (!id) throw new TypeError(`Work unit ${fixtureKey} references unknown local neighbor ${neighborKey}.`);
        return id;
      });
    const externalNeighborIds = assertArray(rawUnit.external_neighbors || [], `work_units.${fixtureKey}.external_neighbors`)
      .map((neighborKey) => {
        const id = externalWorkUnitIdsByKey.get(neighborKey);
        if (!id) throw new TypeError(`Work unit ${fixtureKey} references unknown external neighbor ${neighborKey}.`);
        return id;
      });
    const neighborIds = [...new Set([...localNeighborIds, ...externalNeighborIds])].sort();
    const score = rawUnit.confidence?.score;
    const reasons = [...assertArray(rawUnit.confidence?.reasons, `work_units.${fixtureKey}.confidence.reasons`)].sort();
    let protectedGroupId = null;
    if (rawUnit.protected_group !== null && rawUnit.protected_group !== undefined) {
      protectedGroupId = groupIdsByKey.get(rawUnit.protected_group);
      if (!protectedGroupId) throw new TypeError(`Work unit ${fixtureKey} references unknown protected group ${rawUnit.protected_group}.`);
    }
    workUnits.push({
      work_unit_id: workUnitId,
      identity: canonicalWorkUnitDescriptor(rawUnit.identity),
      canvas_role: rawUnit.canvas_role,
      confidence: {
        score,
        tier: confidenceTier(score),
        reasons,
      },
      opportunity: rawUnit.canvas_role === 'opportunity' ? copyJson(rawUnit.opportunity) : null,
      provenance: copyJson(rawUnit.provenance).sort((left, right) => (
        `${left.source_id}\u0000${left.dataset_version}\u0000${left.feature_id}`
          .localeCompare(`${right.source_id}\u0000${right.dataset_version}\u0000${right.feature_id}`)
      )),
      geometry: copyJson(rawUnit.geometry),
      neighbor_ids: neighborIds,
      protected_group_id: protectedGroupId,
    });
  }
  workUnits.sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id));

  const properties = assertArray(rawTile.properties || [], 'fixture.tiles[].properties').map((rawProperty) => {
    const propertyKey = String(rawProperty.property_key || '');
    const workUnitId = workUnitIdsByKey.get(rawProperty.work_unit);
    if (!workUnitId) throw new TypeError(`Property ${propertyKey} references unknown work unit ${rawProperty.work_unit}.`);
    const score = rawProperty.confidence?.score;
    return {
      property_id: canonicalPropertyId(propertyKey),
      fk_property_id: rawProperty.fk_property_id || `FKP1_${sha256Hex(canonicalStringify({ property_key: propertyKey }))}`,
      property_key: propertyKey,
      work_unit_id: workUnitId,
      point: copyJson(rawProperty.point),
      property_type: rawProperty.property_type,
      canvass_eligibility: rawProperty.canvass_eligibility,
      confidence: { score, tier: confidenceTier(score), reasons: [...assertArray(rawProperty.confidence?.reasons, `properties.${propertyKey}.confidence.reasons`)].sort() },
      door_count: rawProperty.door_count,
      ...(rawProperty.normalized_address ? { normalized_address: rawProperty.normalized_address } : {}),
      ...(rawProperty.display_address ? { display_address: rawProperty.display_address } : {}),
      building_linkage: copyJson(rawProperty.building_linkage || []).sort(),
      road_linkage: copyJson(rawProperty.road_linkage || { work_unit_id: workUnitId, method: 'legacy' }),
      provenance: copyJson(rawProperty.provenance).sort((left, right) => `${left.source_id}\u0000${left.dataset_version}\u0000${left.feature_id}`.localeCompare(`${right.source_id}\u0000${right.dataset_version}\u0000${right.feature_id}`)),
    };
  }).sort((left, right) => left.property_id.localeCompare(right.property_id));

  const tile = {
    schema: CANVAS_EVIDENCE_SCHEMA.tile,
    schema_version: CANVAS_EVIDENCE_SCHEMA.version,
    release_id: releaseId,
    tile_id: tileId,
    tile_address: tileAddress,
    coverage: copyJson(rawTile.coverage),
    external_neighbor_ids: [...externalWorkUnitIdsByKey.values()].sort(),
    work_units: workUnits,
    properties,
    protected_groups: protectedGroups,
  };
  const metrics = validateCanvasEvidenceTile(tile, limits);
  const bytes = Buffer.from(canonicalStringify(tile), 'utf8');
  return {
    tile,
    manifestEntry: {
      tile_id: tileId,
      tile_address: tileAddress,
      uri: `tiles/${tileId}.json`,
      sha256: sha256Hex(bytes),
      byte_length: bytes.byteLength,
      work_unit_count: metrics.work_unit_count,
      property_count: metrics.property_count,
      coverage_area_sq_mi: tile.coverage.area_sq_mi,
      coverage_bounds: copyJson(tile.coverage.bounds),
      expected_opportunities: metrics.expected_opportunities,
    },
  };
}

export function compileCanvasEvidenceFixture(fixture, { privateKey, publicKey, keyId } = {}) {
  const input = assertRecord(fixture, 'fixture');
  const releaseInput = assertRecord(input.release, 'fixture.release');
  const releaseId = canonicalReleaseId(releaseInput);
  const limits = { ...DEFAULT_CANVAS_EVIDENCE_LIMITS, ...(input.limits || {}) };
  const compiledTiles = assertArray(input.tiles, 'fixture.tiles').map((tile) => compileCanvasEvidenceTile(tile, releaseId, limits));
  compiledTiles.sort((left, right) => left.tile.tile_id.localeCompare(right.tile.tile_id));
  const tiles = Object.fromEntries(compiledTiles.map(({ tile }) => [tile.tile_id, tile]));
  const unsignedManifest = {
    schema: CANVAS_EVIDENCE_SCHEMA.manifest,
    schema_version: CANVAS_EVIDENCE_SCHEMA.version,
    release: {
      release_id: releaseId,
      dataset_namespace: releaseInput.dataset_namespace.toLowerCase(),
      dataset_version: releaseInput.dataset_version,
      generated_at: releaseInput.generated_at,
      compiler_version: input.compiler_version,
    },
    coverage: copyJson(input.coverage),
    tile_scheme: copyJson(input.tile_scheme),
    limits,
    sources: copyJson(input.sources).sort((left, right) => left.source_id.localeCompare(right.source_id)),
    tiles: compiledTiles.map(({ manifestEntry }) => manifestEntry),
  };
  const manifest = signCanvasEvidenceManifest(unsignedManifest, { privateKey, keyId });
  validateCanvasEvidenceBundle({ manifest, tiles, publicKey, expectedKeyId: keyId });
  return Object.freeze({ manifest, tiles });
}