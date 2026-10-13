import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { isRepAccount, tenantManagerId } from '../../shared/accountTenancy.js';

// Imported routes are created here for reps and managers. Direct SavedRoute
// create RLS is unreliable for non-admin accounts, so the service role writes it with tenant and assignment
// forced to the calling rep; the client cannot choose another team or rep.
const BLOCKED_KEYS = new Set(['id', 'manager_id', 'assigned_to', 'assigned_to_name', 'status', 'created_by', 'created_by_id', 'parent_route_id', 'start_location', 'end_location']);
const MAX_STOPS = 5000;

Deno.serve(async req => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401 });
    // Reps land in their manager's workspace; managers/owners in their own.
    const appRole = user.app_role || user.data?.app_role || '';
    const managerLike = user.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(user.role);
    const managerId = tenantManagerId(user);
    if (!managerId || (!isRepAccount(user) && !managerLike)) {
      return Response.json({ error: 'Choose a role before importing routes.' }, { status: 403 });
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