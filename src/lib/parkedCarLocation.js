/**
 * One-shot capture of the device's location, used as a parked-car anchor.
 *
 * Deliberately NOT a watcher. The car does not move while the rep walks, so the
 * anchor is captured once, frozen, and reused for the whole optimization. A
 * continuous watch would re-order the route underneath the rep and would keep a
 * precise location stream alive for no benefit.
 *
 * There is no fallback. If the fix fails, the caller must surface the failure
 * and leave the route untouched — silently substituting the map centre, a stale
 * point or the Home Base would anchor the route somewhere the car is not.
 */

export const CAR_LOCATION_TIMEOUT_MS = 10000;

/** Above this, the fix is disclosed to the user before it is used. */
export const CAR_LOCATION_ACCURACY_WARNING_M = 50;

export const CAR_LOCATION_ERRORS = Object.freeze({
    UNSUPPORTED: 'geolocation_unsupported',
    PERMISSION_DENIED: 'permission_denied',
    TIMEOUT: 'timeout',
    UNAVAILABLE: 'position_unavailable',
    INVALID: 'invalid_coordinates'
});

const MESSAGES = Object.freeze({
    [CAR_LOCATION_ERRORS.UNSUPPORTED]: 'This device cannot share its location.',
    [CAR_LOCATION_ERRORS.PERMISSION_DENIED]: 'Location permission was denied. Enable location access and try again.',
    [CAR_LOCATION_ERRORS.TIMEOUT]: 'Your location could not be determined. Try again from an area with a clearer GPS signal.',
    [CAR_LOCATION_ERRORS.UNAVAILABLE]: 'Your location could not be determined. Try again from an area with a clearer GPS signal.',
    [CAR_LOCATION_ERRORS.INVALID]: 'Your device reported an unusable location. Try again.'
});

export function carLocationErrorMessage(code) {
    return MESSAGES[code] || MESSAGES[CAR_LOCATION_ERRORS.UNAVAILABLE];
}

/** Rejects anything that is not a usable geographic point. */
export function normalizeCapturedPoint(coords, capturedAt = Date.now()) {
    const lat = Number(coords?.latitude);
    const lng = Number(coords?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    const rawAccuracy = Number(coords?.accuracy);
    return {
        lat,
        lng,
        accuracy_m: Number.isFinite(rawAccuracy) && rawAccuracy >= 0 ? rawAccuracy : null,
        captured_at: new Date(capturedAt).toISOString()
    };
}

export function isLowAccuracyCapture(point, warnAboveMeters = CAR_LOCATION_ACCURACY_WARNING_M) {
    const accuracy = Number(point?.accuracy_m);
    return Number.isFinite(accuracy) && accuracy > warnAboveMeters;
}

/**
 * Requests a single high-accuracy fix.
 *
 * Resolves `{ ok: true, point }` or `{ ok: false, code, message }`. It never
 * throws and never resolves with a substituted location.
 *
 * `geolocation` is injectable so this is testable without a browser; production
 * callers pass nothing.
 */
export function captureParkedCarLocation({
    geolocation = (typeof navigator !== 'undefined' ? navigator.geolocation : null),
    timeoutMs = CAR_LOCATION_TIMEOUT_MS,
    now = () => Date.now()
} = {}) {
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
        return Promise.resolve({
            ok: false,
            code: CAR_LOCATION_ERRORS.UNSUPPORTED,
            message: carLocationErrorMessage(CAR_LOCATION_ERRORS.UNSUPPORTED)
        });
    }

    return new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        geolocation.getCurrentPosition(
            (position) => {
                const point = normalizeCapturedPoint(position?.coords, now());
                if (!point) {
                    settle({
                        ok: false,
                        code: CAR_LOCATION_ERRORS.INVALID,
                        message: carLocationErrorMessage(CAR_LOCATION_ERRORS.INVALID)
                    });
                    return;
                }
                settle({ ok: true, point });
            },
            (error) => {
                const code = error?.code === 1 ? CAR_LOCATION_ERRORS.PERMISSION_DENIED
                    : error?.code === 3 ? CAR_LOCATION_ERRORS.TIMEOUT
                    : CAR_LOCATION_ERRORS.UNAVAILABLE;
                settle({ ok: false, code, message: carLocationErrorMessage(code) });
            },
            // maximumAge: 0 — never accept a cached fix. The rep may have driven
            // since the last one, and a stale anchor is worse than no anchor.
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
        );
    });
}

/**
 * The `metadata.route_bounds` payload for a car-anchored route.
 *
 * Coordinates, accuracy and capture time only — deliberately no reverse-geocoded
 * address, no device identifier, and no history of previous parking spots.
 */
export function carRouteBoundsMetadata(point) {
    return {
        enabled: true,
        mode: 'car_round_trip',
        start_source: 'gps_snapshot',
        accuracy_m: point?.accuracy_m ?? null,
        captured_at: point?.captured_at ?? null
    };
}
