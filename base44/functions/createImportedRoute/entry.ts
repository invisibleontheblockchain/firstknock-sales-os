import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { isRepAccount, tenantManagerId } from '../../shared/accountTenancy.js';

// Reps may create a route from their own imported list. SavedRoute create RLS is
// manager-only, so the service role writes it here with tenant and assignment
// forced to the calling rep; the client cannot choose another team or rep.
const BLOCKED_KEYS = new Set(['id', 'manager_id', 'assigned_to', 'assigned_to_name', 'status', 'created_by', 'created_by_id', 'parent_route_id', 'start_location', 'end_location']);
const MAX_STOPS = 5000;

Deno.serve(async req => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401 });
    const managerId = tenantManagerId(user);
    if (!isRepAccount(user) || !managerId) {
      return Response.json({ error: 'Only team reps use this import path.' }, { status: 403 });
    }

    const { route } = await req.json().catch(() => ({}));
    const hashes = Array.isArray(route?.property_hashes) ? route.property_hashes.map(String).filter(Boolean) : [];
    if (!route?.name || hashes.length === 0) return Response.json({ error: 'Route name and stops are required.' }, { status: 400 });
    if (hashes.length > MAX_STOPS) return Response.json({ error: `Imports are limited to ${MAX_STOPS} stops.` }, { status: 400 });

    const payload = Object.fromEntries(Object.entries(route).filter(([key]) => !BLOCKED_KEYS.has(key)));
    const created = await base44.asServiceRole.entities.SavedRoute.create({
      ...payload,
      name: String(route.name).slice(0, 250),
      property_hashes: hashes,
      route_mode: 'precision',
      status: 'ACTIVE',
      manager_id: managerId,
      assigned_to: user.id,
      assigned_to_name: user.full_name || 'Me',
    });
    return Response.json({ route: created });
  } catch (error) {
    console.error('Imported route creation failed:', error?.message);
    return Response.json({ error: error?.message || 'Could not create route.' }, { status: 500 });
  }
});