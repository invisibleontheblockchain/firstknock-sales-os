import { canonicalStringify, canonicalWorkUnitId } from '../contract.mjs';

const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (message) => { throw new TypeError(message); };

export function buildTopologyIdentityIndex(compiledTiles) {
  const identities = new Map();
  for (const tile of compiledTiles || []) {
    if (tile?.schema !== 'firstknock.canvas-evidence-tile' || !Array.isArray(tile.work_units)) fail('Phase 05 requires compiled Canvas topology tiles.');
    if ((tile.properties || []).length) fail('Phase 05 topology input must not already contain properties.');
    for (const unit of tile.work_units) {
      const id = canonicalWorkUnitId(unit.identity);
      if (id !== unit.work_unit_id) fail(`Topology work-unit identity mismatch: ${unit.work_unit_id}`);
      const existing = identities.get(id);
      if (existing && canonicalStringify(existing) !== canonicalStringify(unit.identity)) fail(`Conflicting topology identity: ${id}`);
      identities.set(id, copy(unit.identity));
    }
  }
  return identities;
}

export function rehydrateCompiledTopologyTile(compiledTile, releaseIdentityById, outsideIdentityById = new Map()) {
  if (compiledTile?.schema !== 'firstknock.canvas-evidence-tile') fail('Phase 05 requires a compiled Canvas topology tile.');
  if ((compiledTile.properties || []).length) fail('Phase 05 topology tile must have zero properties.');
  const localIds = new Set(compiledTile.work_units.map((unit) => unit.work_unit_id));
  const identityFor = (id) => {
    const releaseIdentity = releaseIdentityById.get(id);
    if (releaseIdentity) return { identity: copy(releaseIdentity), scope: 'release' };
    const outsideIdentity = outsideIdentityById.get(id);
    if (outsideIdentity) return { identity: copy(outsideIdentity), scope: 'outside_release' };
    fail(`Topology neighbor ${id} has no retained identity descriptor.`);
  };
  const groups = new Map((compiledTile.protected_groups || []).map((group) => [group.protected_group_id, group]));
  const protectedGroups = [...groups.values()].map((group) => ({
    kind: group.kind,
    members: group.member_work_unit_ids.map((id) => {
      if (!localIds.has(id)) fail(`Protected group ${group.protected_group_id} crosses its authoritative tile.`);
      return copy(releaseIdentityById.get(id));
    }),
    entries: group.entry_work_unit_ids.map((id) => {
      if (!localIds.has(id)) fail(`Protected group ${group.protected_group_id} has a non-local entry.`);
      return copy(releaseIdentityById.get(id));
    }),
  }));
  const workUnits = compiledTile.work_units.map((unit) => ({
    identity: copy(unit.identity),
    canvas_role: unit.canvas_role,
    confidence: { score: unit.confidence.score, reasons: copy(unit.confidence.reasons) },
    ...(unit.opportunity === null ? {} : { opportunity: copy(unit.opportunity) }),
    provenance: copy(unit.provenance),
    geometry: copy(unit.geometry),
    neighbors: unit.neighbor_ids.map(identityFor),
  }));
  return {
    schema: 'firstknock.canvas-normalized-evidence-tile',
    schema_version: 1,
    tile_address: copy(compiledTile.tile_address),
    coverage: copy(compiledTile.coverage),
    work_units: workUnits,
    properties: [],
    protected_groups: protectedGroups,
  };
}