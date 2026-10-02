import { mergeImportedStops, validCoordinates } from './propertyImportData.js';
import { orderRouteProperties } from '../logic/routeHydrationCore.js';

function assertUser(user) {
  if (!user?.id || !user?.email) throw new Error('Sign in before importing properties.');
}

export function canAppendToRoute(route, user) {
  if (!route?.id || !user?.id || ['COMPLETED', 'ARCHIVED'].includes(route.status)) return false;
  const managerId = user.team_manager_id || user.data?.team_manager_id;
  const admin = (user.role || user.data?.role) === 'admin';
  if (route.manager_id && route.manager_id !== user.id && route.manager_id !== managerId && !admin) return false;
  // Match SavedRoute update permissions. Entity reads and writes still enforce RLS.
  return route.manager_id === user.id || (managerId && route.manager_id === managerId)
    || route.created_by === user.email || admin;
}

export function routeDistanceMiles(properties) {
  let distance = 0;
  for (let i = 1; i < properties.length; i++) {
    const a = properties[i - 1]; const b = properties[i];
    if (!validCoordinates(a) || !validCoordinates(b)) continue;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    distance += 3959 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }
  return Math.round(distance * 100) / 100;
}

export async function savePropertyImport(importBatch, {
  client, user, routeId = null, loadRouteProperties, optimize = properties => properties,
  saveLocal = async () => {}, onProgress = () => {}, persistProperties,
}) {
  assertUser(user);
  if (!importBatch?.properties?.length) throw new Error('There are no properties to import.');
  let route = null;
  let existingProperties = [];
  let additions = importBatch.properties;
  let duplicatesRemoved = 0;
  if (routeId) {
    route = await client.entities.SavedRoute.get(routeId);
    if (!canAppendToRoute(route, user)) throw new Error('This route is unavailable for imports. Choose an active route you can edit.');
    const hydrated = await loadRouteProperties(route);
    const byHash = new Map();
    for (const property of hydrated || []) {
      [property.address_hash, property.legacy_hash, property.id].filter(Boolean).forEach(hash => byHash.set(String(hash), property));
    }
    existingProperties = (route.property_hashes || []).map(hash => byHash.get(String(hash)));
    if (existingProperties.some(property => !property || !validCoordinates(property))) {
      throw new Error('Some existing route stops could not be loaded. Retry before adding properties.');
    }
    const merged = mergeImportedStops(route, existingProperties, importBatch.properties);
    additions = merged.additions;
    duplicatesRemoved = merged.duplicatesRemoved;
    if (!additions.length) return { route: orderRouteProperties(route, existingProperties), added: 0, duplicatesRemoved, total: route.property_hashes.length };
  }

  const last = existingProperties.at(-1);
  additions = optimize(additions, last ? { lat: last.lat, lng: last.lng } : null);
  const persisted = [];
  // Reuse records on retries rather than creating the same imported hash twice.
  for (let i = 0; i < additions.length; i += 100) {
    const batch = additions.slice(i, i + 100);
    onProgress(`Saving properties ${i + 1}–${Math.min(i + 100, additions.length)} of ${additions.length}...`);
    if (persistProperties) {
      const saved = await persistProperties(batch, route?.id || null);
      if (!Array.isArray(saved) || saved.length !== batch.length || saved.some((property, index) => property?.address_hash !== batch[index].address_hash)) {
        throw new Error('Some properties could not be saved. Retry the import before updating the route.');
      }
      persisted.push(...saved);
      continue;
    }
    const response = await client.entities.MasterProperty.filter({
      created_by: user.email, address_hash: { $in: batch.map(property => property.address_hash) },
    }, '-created_date', 500);
    const existing = Array.isArray(response) ? response : response?.items || [];
    const byHash = new Map(existing.map(property => [property.address_hash, property]));
    const newProperties = batch.filter(property => !byHash.has(property.address_hash))
      .map(property => ({ ...property, created_by: user.email }));
    if (newProperties.length) await client.entities.MasterProperty.bulkCreate(newProperties);
    // Existing records carry their statuses and IDs. Never overwrite knock history on reimport.
    persisted.push(...batch.map(property => byHash.get(property.address_hash) || { ...property, created_by: user.email }));
  }

  const propertyHashes = [...(route?.property_hashes || []), ...persisted.map(property => property.address_hash)];
  const allProperties = [...existingProperties, ...persisted];
  const importRecord = { file_name: importBatch.fileName, imported_at: new Date().toISOString(), added: persisted.length };
  let savedRoute;
  if (route) {
    const latest = await client.entities.SavedRoute.get(route.id);
    if (!canAppendToRoute(latest, user)) throw new Error('This route is no longer available for imports. Choose another active route.');
    if (JSON.stringify(latest.property_hashes) !== JSON.stringify(route.property_hashes)) {
      throw new Error('This route changed during the import. Retry to include its latest stops.');
    }
    onProgress('Adding properties to route...');
    const update = {
      property_hashes: propertyHashes,
      metrics: { ...latest.metrics, house_count: propertyHashes.length, distance: routeDistanceMiles(allProperties) },
      metadata: { ...latest.metadata, imports: [...(latest.metadata?.imports || []), importRecord] },
    };
    // Keep name, assignment, status, origin bounds, and existing stop order untouched.
    savedRoute = { ...latest, ...await client.entities.SavedRoute.update(route.id, update), ...update };
  } else {
    onProgress('Creating route...');
    const payload = {
      name: importBatch.routeName, route_mode: 'precision', status: 'ACTIVE',
      property_hashes: propertyHashes,
      metrics: { house_count: propertyHashes.length, distance: routeDistanceMiles(allProperties), score: 100 },
      manager_id: user.team_manager_id || user.data?.team_manager_id || user.id,
      assigned_to: user.id, assigned_to_name: user.full_name || 'Me',
      metadata: { source: 'csv_import', file_name: importBatch.fileName, imports: [importRecord] },
    };
    savedRoute = { ...await client.entities.SavedRoute.create(payload), ...payload };
  }
  // Offline cache failure must not turn an already-saved route into a failed import.
  await saveLocal(persisted).catch(error => console.warn('Import saved; local cache unavailable:', error));
  return { route: orderRouteProperties(savedRoute, allProperties), added: persisted.length, duplicatesRemoved, total: propertyHashes.length };
}
