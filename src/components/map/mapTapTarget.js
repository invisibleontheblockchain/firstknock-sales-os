// Map dots stay drawn at the same size; only the area that accepts a tap grows.
// The tap circle covers 7% more area than before (radius x sqrt(1.07), ~3.4%
// wider), applied on top of the renderer's existing touch tolerance.
export const TAP_AREA_SCALE = 1.07;
export const TAP_RADIUS_SCALE = Math.sqrt(TAP_AREA_SCALE);

// The radius a circle marker accepts taps within: its drawn radius plus the
// stroke and renderer tolerance (Leaflet's own rule), or its explicit touch
// radius when that is larger, scaled by TAP_RADIUS_SCALE.
export function tapRadius(marker) {
    const base = (marker._radius || 0) + (typeof marker._clickTolerance === 'function' ? marker._clickTolerance() : 0);
    return Math.max(base, marker.options?.touchRadius || 0) * TAP_RADIUS_SCALE;
}

export function isWithinTapTarget(marker, point) {
    return point.distanceTo(marker._point) <= tapRadius(marker);
}
