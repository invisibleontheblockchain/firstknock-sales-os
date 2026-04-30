import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

function distanceMiles(a, b) {
    if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return 9999;
    const r = 3959;
    const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
    const dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
    const lat1 = Number(a.lat) * Math.PI / 180;
    const lat2 = Number(b.lat) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return r * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestNeighbor(properties, startLocation) {
    const remaining = [...properties];
    const ordered = [];
    let current = startLocation || remaining[0];

    while (remaining.length > 0) {
        let bestIndex = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const d = distanceMiles(current, remaining[i]);
            if (d < bestDistance) {
                bestDistance = d;
                bestIndex = i;
            }
        }
        const [next] = remaining.splice(bestIndex, 1);
        ordered.push(next);
        current = next;
    }

    return ordered;
}

function routeDistance(properties, startLocation) {
    if (properties.length < 2) return 0;
    let total = startLocation ? distanceMiles(startLocation, properties[0]) : 0;
    for (let i = 0; i < properties.length - 1; i++) total += distanceMiles(properties[i], properties[i + 1]);
    return Math.round(total * 100) / 100;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const properties = Array.isArray(body.properties) ? body.properties : [];
        const housesPerRoute = Math.min(Math.max(Number(body.houses_per_route || 100), 1), 10000);
        const startLocation = body.start_location || null;

        if (properties.length === 0) return Response.json({ success: true, routes: [] });
        if (properties.length > 10000) return Response.json({ error: 'Too many properties for one backend route generation request. Limit is 10,000.' }, { status: 400 });

        const ordered = nearestNeighbor(properties, startLocation);
        const routes = [];
        for (let i = 0; i < ordered.length; i += housesPerRoute) {
            const chunk = ordered.slice(i, i + housesPerRoute);
            routes.push({
                id: `backend-route-${Date.now()}-${routes.length + 1}`,
                name: `Route ${routes.length + 1}`,
                properties: chunk,
                houseCount: chunk.length,
                totalDistance: routeDistance(chunk, startLocation),
                competitivenessScore: Math.round(chunk.length * 10)
            });
        }

        return Response.json({ success: true, count: routes.length, routes });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});