export const MAP_BOOTSTRAP_LIMIT = 1000;
export const MAP_OVERVIEW_LIMIT = 20000;

export function mapTerritoryZipCodes(user) {
    return Array.from(new Set([
        ...(user?.territory_zip_codes || []),
        ...(user?.generated_zip_codes || []),
    ].map(zip => String(zip).trim().slice(0, 5)).filter(Boolean))).sort();
}

export function mapTerritoryQueryKey(user, stage) {
    // Both stages share the legacy prefix used by import/sync invalidations.
    return ['masterProperties', user?.email, mapTerritoryZipCodes(user), stage];
}

export async function fetchMapTerritory(invoke, user, limit) {
    if (!user) return { properties: [], capped: false };
    const response = await invoke('getRouteCandidatesFromNeon', {
        zip_codes: mapTerritoryZipCodes(user),
        sold_months: 'all',
        limit,
        fields: 'map',
    });
    const data = response?.data;
    if (data?.success === false || !Array.isArray(data?.properties)) {
        throw new Error(data?.error || 'Territory homes could not be loaded. Please try again.');
    }
    return { properties: data.properties, capped: data.capped ?? data.properties.length >= limit };
}

// Shared by the map hook and the startup prefetch so both resolve to the same
// cached query; a prefetch started during sign-in is reused, never repeated.
export function mapTerritoryBootstrapOptions(user, invoke, withDeadline) {
    return {
        queryKey: mapTerritoryQueryKey(user, 'bootstrap'),
        staleTime: 1000 * 60 * 15,
        gcTime: 1000 * 60 * 30,
        queryFn: () => withDeadline(() => fetchMapTerritory(invoke, user, MAP_BOOTSTRAP_LIMIT)),
    };
}
