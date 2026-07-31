import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { createHash } from 'node:crypto';
import {
  addressDedupeKey,
  normalizeZip,
  parseHouseNumber,
  parseStreetName,
} from '../../shared/addressNormalize.js';
import { tenantManagerId, toEntityArray as toArray } from '../../shared/accountTenancy.js';

const DUPLICATE_SCAN_LIMIT = 400;

function leadAddressHash(dedupeKey) {
  return createHash('sha256').update(`manual_lead|${dedupeKey}`).digest('hex');
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const address = String(body.address || '').trim();
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!address) return Response.json({ error: 'missing_address', message: 'An address is required to create a lead.' }, { status: 400 });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180
      || (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)) {
      return Response.json({ error: 'invalid_coordinates', message: 'This address has no usable map location.' }, { status: 400 });
    }

    const zip = normalizeZip(body.zip);
    const dedupeKey = addressDedupeKey({ address, zip });
    const addressHash = leadAddressHash(dedupeKey);
    const managerId = tenantManagerId(user);

    // Server-side duplicate protection. A client-side check alone cannot stop
    // two devices creating the same lead at once.
    const existingByHash = toArray(
      await base44.asServiceRole.entities.MasterProperty
        .filter({ address_hash: addressHash }, '-created_date', 1)
        .catch(() => [])
    )[0] || null;
    if (existingByHash) {
      return Response.json({ success: true, duplicate: true, property: existingByHash });
    }

    const houseNumber = parseHouseNumber(body.house_number ?? address);
    const streetName = String(body.street_name || parseStreetName(address) || '').trim();
    if (houseNumber === null || !streetName) {
      return Response.json({
        error: 'incomplete_address',
        message: 'Add a house number and street so this lead can be placed on the map.',
      }, { status: 400 });
    }

    // Second duplicate pass against already-stored doors on the same street/ZIP,
    // so an imported provider record is reused instead of duplicated.
    const sameStreet = toArray(
      await base44.asServiceRole.entities.MasterProperty
        .filter({ house_number: houseNumber }, '-created_date', DUPLICATE_SCAN_LIMIT)
        .catch(() => [])
    );
    const duplicate = sameStreet.find((row) => (
      addressDedupeKey({ address: row.full_address || row.address || `${row.house_number} ${row.street_name}`, zip: row.zip_code || row.zip }) === dedupeKey
    ));
    if (duplicate) return Response.json({ success: true, duplicate: true, property: duplicate });

    const created = await base44.asServiceRole.entities.MasterProperty.create({
      address_hash: addressHash,
      house_number: houseNumber,
      street_name: streetName,
      full_address: address,
      address,
      city: String(body.city || '').trim() || undefined,
      state: String(body.state || '').trim() || undefined,
      zip_code: zip || undefined,
      lat,
      lng,
      original_status: 'ELIGIBLE',
      data_source: 'manual',
      route_active: true,
      manager_id: managerId || undefined,
      owner_full_name: String(body.owner_full_name || '').trim() || undefined,
      owner_phone: String(body.owner_phone || '').trim() || undefined,
      description: String(body.notes || '').trim() || undefined,
    });

    return Response.json({ success: true, duplicate: false, property: created });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});