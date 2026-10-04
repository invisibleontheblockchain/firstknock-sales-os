export const PUBLIC_OSRM_DEMO = 'https://router.project-osrm.org';

// Production must explicitly select its authority; a URL label cannot change
// the Lua profile baked into an OSRM graph.
export function vehicleProviderConfig({ baseUrl, profile = 'driving', production = false } = {}) {
    if (production && !baseUrl?.trim()) throw new Error('Configure a private driving OSRM provider before enabling curbside routing.');
    let url;
    try { url = new URL(baseUrl || PUBLIC_OSRM_DEMO); } catch { throw new Error('Invalid vehicle provider URL.'); }
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Vehicle provider URL must contain only the service origin and optional path.');
    }
    if (production && (hostname === 'project-osrm.org' || hostname.endsWith('.project-osrm.org'))) {
        throw new Error('The public OSRM demo is prohibited for production curbside routing.');
    }
    if (production && url.protocol !== 'https:') throw new Error('Production vehicle routing requires HTTPS.');
    if (!['car', 'driving'].includes(profile)) throw new Error('Vehicle routing requires a configured car/driving profile.');
    return Object.freeze({ baseUrl: url.toString().replace(/\/+$/, ''), profile });
}

export function validateVehicleProductionBuild(env) {
    // Release is opt-in. An unset flag must not quietly enable a demo provider.
    if (env.VITE_STREET_SIDE_ROUTING === 'false') return null;
    if (env.VITE_STREET_SIDE_ROUTING !== 'true') {
        throw new Error('Set VITE_STREET_SIDE_ROUTING=false until production driving validation passes.');
    }
    return vehicleProviderConfig({ baseUrl: env.VITE_OSRM_BASE_URL, profile: env.VITE_OSRM_API_PROFILE || 'driving', production: true });
}
