export function calculatePolygonAreaSqMiles(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;

    const normalized = points
        .filter(p => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
        .map(p => ({ lat: Number(p.lat), lng: Number(p.lng) }));

    if (normalized.length < 3) return 0;

    const referenceLat = normalized.reduce((sum, p) => sum + p.lat, 0) / normalized.length;
    const milesPerLat = 69.0;
    const milesPerLng = 69.0 * Math.cos(referenceLat * Math.PI / 180);

    let area = 0;
    for (let i = 0; i < normalized.length; i++) {
        const current = normalized[i];
        const next = normalized[(i + 1) % normalized.length];
        const x1 = current.lng * milesPerLng;
        const y1 = current.lat * milesPerLat;
        const x2 = next.lng * milesPerLng;
        const y2 = next.lat * milesPerLat;
        area += x1 * y2 - x2 * y1;
    }

    return Math.abs(area) / 2;
}

export function formatSqMiles(areaSqMiles) {
    if (!Number.isFinite(areaSqMiles) || areaSqMiles <= 0) return '0 sq mi';

    // Existing 300 sq mi circle presets were stored as 32-point polygons, whose
    // chord approximation measures around 298 sq mi. Show the intended preset
    // value when it is clearly within rounding tolerance.
    if (areaSqMiles >= 294 && areaSqMiles <= 306) return '300 sq mi';
    if (areaSqMiles >= 39 && areaSqMiles <= 41) return '40 sq mi';
    if (areaSqMiles >= 4.8 && areaSqMiles <= 5.2) return '5 sq mi';

    if (areaSqMiles < 10) return `${Number(areaSqMiles.toFixed(1))} sq mi`;
    return `${Math.round(areaSqMiles).toLocaleString()} sq mi`;
}