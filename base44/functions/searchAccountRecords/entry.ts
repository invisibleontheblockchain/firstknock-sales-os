import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import { normalizeAddress, normalizeName, normalizeZip } from '../../shared/addressNormalize.js';
import { tenantManagerId, toEntityArray as toArray } from '../../shared/accountTenancy.js';

const MAX_LIMIT = 12;
const NAME_SCAN_LIMIT = 1000;

/**
 * Workspace emails whose stored properties this caller may search.
 * A rep searches their own workspace plus their manager's account workspace,
 * and never another customer account's workspace.
 */
async function resolveWorkspaceEmails(base44, user) {
  const emails = new Set();
  const own = String(user?.email || '').trim().toLowerCase();
  if (own) emails.add(own);
  const managerId = tenantManagerId(user);
  if (managerId && managerId !== user?.id) {
    const manager = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
    const managerEmail = String(manager?.email || '').trim().toLowerCase();
    if (managerEmail) emails.add(managerEmail);
  }
  return [...emails];
}

function displayAddress(row) {
  const base = String(row.full_address || '').trim();
  const zip = String(row.zip_code || '').trim();
  // Provider rows often already carry city/state/ZIP inside full_address;
  // appending them again produced doubled result subtitles.
  if (base && zip && base.includes(zip)) return base;
  return [base, row.city, row.state, zip].filter(Boolean).join(', ');
}

function recordFromProperty(row) {
  return {
    type: 'record',
    source: 'internal',
    id: String(row.id),
    address_hash: row.address_hash || String(row.id),
    legacy_hash: row.legacy_hash || null,
    name: row.owner_full_name || null,
    formatted_address: [row.full_address, row.city, row.state, row.zip_code].filter(Boolean).join(', '),
    street: row.full_address || null,
    city: row.city || null,
    state: row.state || null,
    zip: row.zip_code || null,
    status: row.status || row.original_status || null,
    lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
    lng: row.lng === null || row.lng === undefined ? null : Number(row.lng),
    route_label: row.route_name || null,
    last_interaction_at: null,
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const rawQuery = String(body.query || '').trim();
    if (rawQuery.length < 2) return Response.json({ success: true, results: [] });
    const limit = Math.min(Math.max(Number(body.limit) || 8, 1), MAX_LIMIT);

    const managerId = tenantManagerId(user);
    const workspaceEmails = await resolveWorkspaceEmails(base44, user);
    const normalizedQuery = normalizeName(rawQuery);
    const addressQuery = normalizeAddress(rawQuery);
    const likeQuery = `%${rawQuery.replace(/[%_]/g, ' ').trim()}%`;

    const results = [];

    // 1. Stored properties inside this account's workspace only.
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (databaseUrl && workspaceEmails.length > 0) {
      const sql = neon(databaseUrl);
      const rows = await sql`
        SELECT DISTINCT ON (p.id)
          p.id, p.address_hash, p.legacy_hash, p.full_address, p.city, p.state, p.zip_code,
          p.lat, p.lng, p.owner_full_name, p.original_status, wp.status
        FROM workspace_properties wp
        JOIN properties p ON p.id = wp.property_id
        WHERE wp.user_email = ANY(${workspaceEmails})
          AND (p.full_address ILIKE ${likeQuery} OR p.owner_full_name ILIKE ${likeQuery})
        ORDER BY p.id, p.updated_at DESC
        LIMIT ${limit * 3}
      `;
      for (const row of rows) results.push(recordFromProperty(row));
    }

    // 2. Named people the account has actually worked: appointments and sales
    //    history. Both entities are tenant-keyed by manager_id.
    if (managerId) {
      const [appointments, interactions, savedRoutes] = await Promise.all([
        base44.asServiceRole.entities.Appointment
          .filter({ manager_id: managerId }, '-created_date', NAME_SCAN_LIMIT)
          .catch(() => []),
        base44.asServiceRole.entities.InteractionLog
          .filter({ manager_id: managerId }, '-created_date', NAME_SCAN_LIMIT)
          .catch(() => []),
        base44.entities.SavedRoute.list('-created_date', NAME_SCAN_LIMIT).catch(() => []),
      ]);

      for (const route of toArray(savedRoutes)) {
        if (!normalizeName(route.name).includes(normalizedQuery)) continue;
        const doorCount = Number(route.metrics?.house_count || route.property_hashes?.length || 0);
        results.push({
          type: 'route',
          source: 'internal',
          id: String(route.id),
          route_id: String(route.id),
          name: route.name || 'Unnamed route',
          formatted_address: `${doorCount.toLocaleString()} doors${route.assigned_to_name ? ` • ${route.assigned_to_name}` : ''}`,
          status: route.status || null,
          route_label: 'Saved route',
          last_interaction_at: route.updated_date || route.created_date || null,
        });
      }

      for (const appointment of toArray(appointments)) {
        if (!normalizeName(appointment.homeowner_name).includes(normalizedQuery)
          && !normalizeAddress(appointment.full_address).includes(addressQuery)) continue;
        results.push({
          type: 'record',
          source: 'internal',
          id: String(appointment.id),
          address_hash: appointment.address_hash || null,
          name: appointment.homeowner_name || null,
          formatted_address: appointment.full_address || null,
          city: null,
          state: null,
          zip: normalizeZip(appointment.zip_code) || null,
          status: appointment.status || null,
          lat: Number.isFinite(Number(appointment.lat)) ? Number(appointment.lat) : null,
          lng: Number.isFinite(Number(appointment.lng)) ? Number(appointment.lng) : null,
          route_label: appointment.assigned_rep_name || null,
          last_interaction_at: appointment.scheduled_date || appointment.created_date || null,
        });
      }

      for (const log of toArray(interactions)) {
        if (!log.homeowner_name && !log.property_address) continue;
        if (!normalizeName(log.homeowner_name).includes(normalizedQuery)
          && !normalizeAddress(log.property_address).includes(addressQuery)) continue;
        results.push({
          type: 'record',
          source: 'internal',
          id: String(log.id),
          address_hash: log.address_hash || null,
          name: log.homeowner_name || null,
          formatted_address: log.property_address || null,
          status: log.parsed_status || null,
          lat: Number.isFinite(Number(log.gps_proof_lat)) ? Number(log.gps_proof_lat) : null,
          lng: Number.isFinite(Number(log.gps_proof_lng)) ? Number(log.gps_proof_lng) : null,
          route_label: log.route_name || null,
          last_interaction_at: log.created_date || null,
        });
      }
    }

    // Collapse aliases of the same door, keeping the entry with the most context.
    const byKey = new Map();
    for (const result of results) {
      const key = result.type === 'route'
        ? `route:${result.route_id || result.id}`
        : result.address_hash || `${normalizeAddress(result.formatted_address)}|${normalizeName(result.name)}`;
      const existing = byKey.get(key);
      const score = (result.name ? 2 : 0) + (result.lat !== null ? 2 : 0) + (result.last_interaction_at ? 1 : 0);
      const existingScore = existing
        ? (existing.name ? 2 : 0) + (existing.lat !== null ? 2 : 0) + (existing.last_interaction_at ? 1 : 0)
        : -1;
      if (score > existingScore) {
        byKey.set(key, existing ? { ...existing, ...result, name: result.name || existing.name } : result);
      } else if (existing && !existing.name && result.name) {
        byKey.set(key, { ...existing, name: result.name });
      }
    }

    return Response.json({
      success: true,
      results: [...byKey.values()].slice(0, limit),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}