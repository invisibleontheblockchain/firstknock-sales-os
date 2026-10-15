// Search history changes scheduling only. It cannot supply a road cost, waive a
// provider request, or approve a route. Only opaque question hashes are stored.
export const ROAD_SEARCH_COVERAGE_VERSION = 1;
export const MAX_ROAD_SEARCH_COVERAGE_KEYS = 8192;
const identity = stop => String(stop?.address_hash || stop?.legacy_hash || stop?.id || '');
const validKey = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

function canonical(value, seen = new Set()) {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return Number.isNaN(value) ? 'NaN' : value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => canonical(item, seen))
        : Object.fromEntries(Object.keys(value).sort().filter(key => typeof value[key] !== 'function')
            .map(key => [key, canonical(value[key], seen)]));
    seen.delete(value);
    return result;
}

function opaqueHash(value) {
    const hashes = [2166136261, 2246822507, 3266489909, 668265263];
    for (const character of JSON.stringify(canonical(value))) {
        const code = character.charCodeAt(0);
        for (let i = 0; i < hashes.length; i++) hashes[i] = Math.imul(hashes[i] ^ code, 16777619 + i * 2) >>> 0;
    }
    return hashes.map(value => value.toString(16).padStart(8, '0')).join('');
}

export function roadSearchWindowKey(order, window, options = {}, policy = '') {
    const locks = new Set((options.lockedStopIds || []).map(String));
    const unresolved = new Set((options.unresolvedStopIds || []).map(String));
    const discoveryNames = ['house_number', 'street_name', 'street', 'address', 'address_line_1', 'city', 'state',
        'zip_code', 'zip', 'subdivision', 'subdivision_name', 'neighborhood_name', 'neighborhoodName'];
    const point = stop => stop ? { id: identity(stop), lat: stop.lat, lng: stop.lng,
        locked: Boolean(stop.locked || stop.order_locked || locks.has(identity(stop))),
        unresolved: unresolved.has(identity(stop)), access: stop.routing_access || null,
        knownAccess: options.knownDrivingAccessFor?.(stop) || null,
        discovery: Object.fromEntries(discoveryNames.map(name => [name, stop[name] ?? null])) } : null;
    const settingNames = ['vehicleBaseUrl', 'vehicleProfile', 'mailCarrierMode', 'localSearchWidth', 'maxLocalCandidates',
        'maxAreaCandidates', 'maxAreaMoveUnits', 'preferContiguousOnTie', 'tieSeconds', 'inferStreetSides',
        'areaDrivingReview', 'maxLocalStops', 'localRadiusMiles', 'minAreaWindowStops', 'maxAreaWindowStops',
        'areaRadiusMiles', 'maxServiceWindowStops',
        'maxShortWindows', 'shortRadiusMiles', 'minShortGainMiles', 'requireNoDrivingIncrease'];
    return opaqueHash({ policy, phase: window.short ? 'short' : 'main', size: window.end - window.start,
        kinds: [Boolean(window.area), Boolean(window.service), Boolean(window.local)],
        offset: Math.min(2, window.start), section: order.slice(Math.max(0, window.start - 2), window.end + 2).map(point),
        start: point(options.startLocation), end: point(options.endLocation), returnToStart: options.returnToStart === true,
        settings: Object.fromEntries(settingNames.map(name => [name, options[name] ?? null])) });
}

export function createRoadSearchCoverage(history, policy) {
    const valid = history?.version === ROAD_SEARCH_COVERAGE_VERSION && history.policy === policy
        && Array.isArray(history.completed_window_keys) && history.completed_window_keys.length <= MAX_ROAD_SEARCH_COVERAGE_KEYS
        && history.completed_window_keys.every(validKey);
    const previous = new Set(valid && history.cycle_complete !== true ? history.completed_window_keys : []);
    const completed = new Set(previous);
    let checked = 0;
    return {
        key: (order, window, options) => roadSearchWindowKey(order, window, options, policy),
        prioritize(windows, keyFor) {
            const unseen = [], seen = [];
            for (const window of windows) (completed.has(keyFor(window)) ? seen : unseen).push(window);
            return [...unseen, ...seen];
        },
        attempt() { checked++; },
        complete(key) {
            // A pass can add at most 100 main and 24 short questions. Allow
            // those transient entries before pruning obsolete local contexts;
            // an old full ledger must not block new progress after a repair.
            if (validKey(key) && completed.size < MAX_ROAD_SEARCH_COVERAGE_KEYS + 124) completed.add(key);
        },
        report(eligibleKeys) {
            const eligible = [...new Set(eligibleKeys)].filter(validKey);
            const retained = eligible.filter(key => completed.has(key)).slice(0, MAX_ROAD_SEARCH_COVERAGE_KEYS);
            const remaining = eligible.length - retained.length;
            return { version: ROAD_SEARCH_COVERAGE_VERSION, policy, completed_window_keys: retained,
                total_windows: eligible.length, remaining_windows: remaining, checked_this_pass: checked,
                progress_this_pass: retained.filter(key => !previous.has(key)).length, cycle_complete: remaining === 0 };
        },
    };
}
