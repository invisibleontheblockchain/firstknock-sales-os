/**
 * Route origin modes — the single source of truth.
 *
 * This list was previously duplicated as an inline array literal at six call
 * sites. Each copy independently decided whether a mode was recognized, and an
 * unrecognized value was silently downgraded to `none` with no error, which
 * meant adding a mode required finding every copy. One constant instead.
 */
export const ROUTE_ORIGIN_MODES = Object.freeze({
    NONE: 'none',
    HOME_ROUND_TRIP: 'home_round_trip',
    CURRENT_TO_HOME: 'current_to_home',
    CAR_ROUND_TRIP: 'car_round_trip'
});

/** Modes that carry an external start/end anchor. `none` deliberately does not. */
export const ANCHORED_ROUTE_ORIGIN_MODES = Object.freeze([
    ROUTE_ORIGIN_MODES.HOME_ROUND_TRIP,
    ROUTE_ORIGIN_MODES.CURRENT_TO_HOME,
    ROUTE_ORIGIN_MODES.CAR_ROUND_TRIP
]);

/** Modes whose start and finish are the same point. */
export const ROUND_TRIP_ROUTE_ORIGIN_MODES = Object.freeze([
    ROUTE_ORIGIN_MODES.HOME_ROUND_TRIP,
    ROUTE_ORIGIN_MODES.CAR_ROUND_TRIP
]);

export function isAnchoredRouteOriginMode(mode) {
    return ANCHORED_ROUTE_ORIGIN_MODES.includes(mode);
}

export function isRoundTripRouteOriginMode(mode) {
    return ROUND_TRIP_ROUTE_ORIGIN_MODES.includes(mode);
}

/** Anything unrecognized becomes `none`, preserving the established behaviour. */
export function normalizeRouteOriginMode(mode) {
    return isAnchoredRouteOriginMode(mode) ? mode : ROUTE_ORIGIN_MODES.NONE;
}

/* ── The optimization choices offered by the Optimize menu ── */

export const OPTIMIZE_MODES = Object.freeze({
    ROUTE_ONLY: 'route_only',
    HOME_ROUND_TRIP: 'home_round_trip',
    CAR_ROUND_TRIP: 'car_round_trip'
});

export const OPTIMIZE_MODE_VALUES = Object.freeze(Object.values(OPTIMIZE_MODES));

/**
 * The route_origin_mode persisted for a given optimization choice.
 *
 * `route_only` deliberately maps to `none`: optimizing on the doors alone must
 * clear any previous external anchor rather than inherit a stale one.
 */
export function routeOriginModeForOptimizeMode(optimizeMode) {
    if (optimizeMode === OPTIMIZE_MODES.HOME_ROUND_TRIP) return ROUTE_ORIGIN_MODES.HOME_ROUND_TRIP;
    if (optimizeMode === OPTIMIZE_MODES.CAR_ROUND_TRIP) return ROUTE_ORIGIN_MODES.CAR_ROUND_TRIP;
    return ROUTE_ORIGIN_MODES.NONE;
}

/**
 * Translates the legacy `{ fromHome: true }` option shape.
 *
 * Older call sites (saved-route cards, the command panel) still send it. They
 * keep working; everything new sends an explicit mode.
 */
export function resolveOptimizeMode(options = {}) {
    const requested = options?.mode;
    if (OPTIMIZE_MODE_VALUES.includes(requested)) return requested;
    if (options?.fromHome === true) return OPTIMIZE_MODES.HOME_ROUND_TRIP;
    return OPTIMIZE_MODES.ROUTE_ONLY;
}
