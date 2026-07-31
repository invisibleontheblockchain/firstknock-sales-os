import { determineEffectiveStatus } from '@/components/logic/territoryLogic';

export function buildLogsByAddress(logs = []) {
  const byAddress = new Map();
  (Array.isArray(logs) ? logs : []).forEach((log) => {
    if (!log?.address_hash) return;
    if (!byAddress.has(log.address_hash)) byAddress.set(log.address_hash, []);
    byAddress.get(log.address_hash).push(log);
  });
  return byAddress;
}

// Route properties hydrated from the backend arrive without effective_status —
// only the map's own property set runs through determineEffectiveStatus. Without
// this, a door with a SOLD outcome kept rendering and reading as ELIGIBLE.
export function withDerivedStatus(properties = [], logsByAddress = new Map(), localByHash = null) {
  return (Array.isArray(properties) ? properties : []).map((property) => {
    const hash = property?.address_hash || property?.id;
    const propertyLogs = [
      ...(logsByAddress.get(hash) || []),
      ...(property?.legacy_hash && property.legacy_hash !== hash
        ? (logsByAddress.get(property.legacy_hash) || [])
        : []),
    ];
    if (propertyLogs.length === 0) {
      const local = localByHash?.get(hash) || (property?.legacy_hash ? localByHash?.get(property.legacy_hash) : null);
      if (local?.effective_status) return { ...property, address_hash: hash, effective_status: local.effective_status };
    }
    return { ...property, address_hash: hash, effective_status: determineEffectiveStatus(property || {}, propertyLogs) };
  });
}