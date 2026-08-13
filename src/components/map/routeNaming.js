/**
 * Route naming — extracted from Home.jsx unchanged in behaviour.
 *
 * A generated route is named after the area its doors actually sit in (county,
 * then city, ZIP or street) and numbered so it continues from the highest
 * existing route with the same base name instead of restarting at 1.
 */

const cleanRouteAreaLabel = (value) => {
    if (value === undefined || value === null) return '';
    return String(value).trim().replace(/\s+/g, ' ').replace(/\bcounty\b$/i, '').trim();
};

function mostCommonRouteLabel(properties, getters) {
    const counts = new Map();
    properties.forEach((property) => {
        for (const getter of getters) {
            const value = cleanRouteAreaLabel(getter(property));
            if (value) {
                counts.set(value, (counts.get(value) || 0) + 1);
                break;
            }
        }
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

const isStockRouteName = (name) => /^(precision\s+route|canvas\s+route|route)\s+\d+$/i.test(String(name || '').trim());

export function deriveRouteName(route, savedRoutes = []) {
    if (route?.name && !isStockRouteName(route.name)) return route.name;
    const props = route?.allProperties || route?.properties || [];
    const batchIndex = Number(String(route?.name || '').match(/(\d+)$/)?.[1] || route?.route_number || 1) || 1;
    const county = mostCommonRouteLabel(props, [
        p => p.county,
        p => p.county_name,
        p => p.countyName,
        p => p.raw_metadata?.county,
        p => p.raw_metadata?.county_name,
        p => p.raw_metadata?.COUNTY,
        p => p.raw_metadata?.County
    ]);
    const city = mostCommonRouteLabel(props, [p => p.city, p => p.raw_metadata?.city, p => p.raw_metadata?.CITY, p => p.raw_metadata?.City]);
    const zip = mostCommonRouteLabel(props, [p => p.zip_code, p => p.zip, p => p.raw_metadata?.zip, p => p.raw_metadata?.ZIP]);
    const street = mostCommonRouteLabel(props, [p => p.street_name]);
    const area = county ? `${county} County` : city || (zip ? `ZIP ${zip}` : street || 'Territory');
    const type = route?.route_mode === 'canvas' ? 'Canvas' : 'Precision';
    const base = `${area} ${type} Route`;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(?:New\\s*[—-]\\s*)?${escaped}\\s+(\\d+)`, 'i');
    let maxExisting = 0;
    (savedRoutes || []).forEach((r) => {
        const m = String(r.name || '').match(pattern);
        if (m) maxExisting = Math.max(maxExisting, Number(m[1]) || 0);
    });
    return `${base} ${maxExisting + batchIndex}`;
}