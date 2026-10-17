// Stops the optimizer routed from the nearest road because neither the pin nor
// the address could be matched to their own street ("approximate road access").
// The map and the stop sheet mark them so a manager can see which stops have
// uncertain access.

const recoveryOf = route => route?.metadata?.road_access_recovery || route?.metadata?.routing?.road_access_recovery || null;

/** Map of property id -> { snapMeters, stopNumber } for a route's approximate stops. */
export function approximateAccessStops(route) {
    const stops = new Map();
    const recovery = recoveryOf(route);
    for (const item of Array.isArray(recovery?.approximate) ? recovery.approximate : []) {
        if (typeof item?.property_id !== 'string' || !item.property_id) continue;
        stops.set(item.property_id, {
            snapMeters: Number.isFinite(item.snap_meters) ? item.snap_meters : null,
            stopNumber: Number.isInteger(item.stop_number) ? item.stop_number : null,
        });
    }
    for (const [id, access] of Object.entries(recovery?.access_overrides || {})) {
        if ((access?.approximate || access?.source === 'approximate_nearest_road') && !stops.has(id)) {
            stops.set(id, { snapMeters: Number.isFinite(access?.evidence?.snapMeters) ? Math.round(access.evidence.snapMeters) : null, stopNumber: null });
        }
    }
    return stops;
}

export const APPROXIMATE_ACCESS_COLOR = '#F59E0B';
