import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const FIELDS = ['address_hash', 'legacy_hash', 'house_number', 'street_name', 'full_address', 'address',
  'city', 'state', 'zip_code', 'zip', 'lat', 'lng', 'owner_full_name', 'original_status', 'status',
  'data_source', 'raw_metadata', 'beds', 'baths', 'sqft', 'year_built', 'price', 'sale_price',
  'sale_date', 'sold_date', 'sale_type', 'property_type', 'mls_id', 'url'];
const ORIGINAL_STATUSES = ['ELIGIBLE', 'SOLD', 'HARD_NO', 'DO_NOT_KNOCK', 'UNVERIFIED'];
const rows = value => Array.isArray(value) ? value : value?.items || [];

const normalized = value => String(value || '').trim().toLowerCase();
const isServiceImport = property => /^service\+[^@\s]+@no-reply\.base44\.com$/i.test(String(property?.created_by || ''))
  && ['csv_import', 'redfin_csv'].includes(property?.data_source);

// created_by is platform-managed: service creates retain the service identity.
// Stamp the verified workspace on manager_id instead of forging audit metadata.
export async function persistProperties(client, user, body) {
  const properties = body?.properties;
  if (!Array.isArray(properties) || !properties.length || properties.length > 100) {
    return { status: 400, error: 'Send between 1 and 100 properties.' };
  }
  const teamManagerId = user.team_manager_id || user.data?.team_manager_id;
  let managerId = teamManagerId || user.id;
  if (body.route_id) {
    // User-scoped read enforces route visibility before any service-role write.
    const route = await client.entities.SavedRoute.get(body.route_id).catch(() => null);
    if (!route || ['COMPLETED', 'ARCHIVED'].includes(route.status)) return { status: 403, error: 'Choose an active route you can edit.' };
    const admin = (user.role || user.data?.role) === 'admin';
    const belongsToWorkspace = route.manager_id === user.id || (teamManagerId && route.manager_id === teamManagerId);
    const ownLegacyRoute = !route.manager_id && route.created_by === user.email;
    if (!belongsToWorkspace && !ownLegacyRoute && !admin) return { status: 403, error: 'This route belongs to another workspace.' };
    managerId = route.manager_id || user.id;
  }
  let ownerEmail = user.email;
  if (managerId !== user.id) {
    const manager = await client.asServiceRole.entities.User.get(managerId).catch(() => null);
    if (!manager?.email) return { status: 403, error: 'The route workspace owner could not be verified.' };
    ownerEmail = manager.email;
  }

  const clean = [];
  const hashes = new Set();
  // Every hash a record may already be stored under: its own, plus the hash
  // the previous import scheme gave the same address (legacy_hash).
  const lookupHashes = new Set();
  const validHash = value => typeof value === 'string' && value.trim() && value.length <= 160;
  for (const property of properties) {
    if (!property || typeof property !== 'object' || Array.isArray(property)
      || !validHash(property.address_hash)
      || hashes.has(property.address_hash)
      || (property.legacy_hash !== undefined && !validHash(property.legacy_hash))
      || !Number.isInteger(property.house_number) || typeof property.street_name !== 'string'
      || typeof property.lat !== 'number' || typeof property.lng !== 'number'
      || !Number.isFinite(property.lat) || !Number.isFinite(property.lng)
      || Math.abs(property.lat) > 90 || Math.abs(property.lng) > 180 || (property.lat === 0 && property.lng === 0)
      || !ORIGINAL_STATUSES.includes(property.original_status)
      || !['csv_import', 'redfin_csv'].includes(property.data_source)) {
      return { status: 400, error: 'Invalid imported property fields.' };
    }
    hashes.add(property.address_hash);
    lookupHashes.add(property.address_hash);
    const record = { ...Object.fromEntries(FIELDS.filter(field => property[field] !== undefined).map(field => [field, property[field]])), manager_id: managerId };
    if (record.legacy_hash === record.address_hash) delete record.legacy_hash;
    if (record.legacy_hash) lookupHashes.add(record.legacy_hash);
    clean.push(record);
  }
  const entity = client.asServiceRole.entities.MasterProperty;
  const belongsToWorkspace = property => (
    isServiceImport(property) && property.manager_id === managerId
  ) || (
    normalized(property?.created_by) === normalized(ownerEmail)
    && (!property.manager_id || property.manager_id === managerId)
  );
  const readExisting = async () => [
    ...rows(await entity.filter({ manager_id: managerId, address_hash: { $in: [...lookupHashes] } }, '-created_date', 500)),
    ...rows(await entity.filter({ created_by: ownerEmail, address_hash: { $in: [...lookupHashes] } }, '-created_date', 500)),
  ].filter(belongsToWorkspace);
  const byHash = new Map();
  for (const property of await readExisting()) {
    if (!byHash.has(property.address_hash)) byHash.set(property.address_hash, property);
  }
  // The record already saved for this door, whichever import scheme hashed it.
  const existingFor = property => byHash.get(property.address_hash) || (property.legacy_hash ? byHash.get(property.legacy_hash) : undefined);
  const missing = clean.filter(property => !existingFor(property));
  if (missing.length) {
    const created = rows(await entity.bulkCreate(missing));
    created.forEach(property => byHash.set(property.address_hash, property));
  }
  // Read back if the runtime bulk-create response doesn't include the records.
  if (clean.some(property => !existingFor(property))) {
    (await readExisting()).forEach(property => byHash.set(property.address_hash, property));
  }
  const saved = clean.map(existingFor);
  if (saved.some(property => !property || !belongsToWorkspace(property))) return { status: 502, error: 'Some imported properties could not be saved. Retry the import.' };
  return { status: 200, properties: saved };
}

Deno.serve(async req => {
  try {
    const client = createClientFromRequest(req);
    const user = await client.auth.me();
    if (!user?.id || !user?.email) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const result = await persistProperties(client, user, body);
    return Response.json(result.error ? { error: result.error } : { properties: result.properties }, { status: result.status });
  } catch (error) {
    console.error('Property import persistence failed:', error?.message);
    return Response.json({ error: 'Properties could not be saved. Please retry the import.' }, { status: 500 });
  }
});
