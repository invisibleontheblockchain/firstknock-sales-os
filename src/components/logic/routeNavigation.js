export const MAX_NAVIGATION_URL_LENGTH = 2048;
export const GOOGLE_MOBILE_WEB_MAX_STOPS = 4;
export const GOOGLE_NATIVE_OR_DESKTOP_MAX_STOPS = 10;
export const APPLE_UNIFIED_MAX_STOPS = 15;

const MOBILE_USER_AGENT = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
const IOS_USER_AGENT = /iPhone|iPad|iPod|CPU (?:iPhone )?OS/i;
const VALID_TRAVEL_MODES = new Set(['driving', 'walking', 'transit', 'bicycling', 'cycling']);

function compareVersion(major, minor, requiredMajor, requiredMinor) {
    if (major !== requiredMajor) return major - requiredMajor;
    return minor - requiredMinor;
}

export function parseIOSVersion(userAgent = '') {
    const match = String(userAgent).match(/(?:CPU (?:iPhone )?OS|iPhone OS)\s+(\d+)[_.](\d+)/i);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
}

export function detectNavigationEnvironment({ userAgent = '', isNative = false, platform = 'web' } = {}) {
    const normalizedPlatform = String(platform || 'web').toLowerCase();
    const iosVersion = parseIOSVersion(userAgent);
    const isIOS = normalizedPlatform === 'ios' || IOS_USER_AGENT.test(String(userAgent));
    const isLegacyAppleMaps = Boolean(
        isIOS
        && iosVersion
        && compareVersion(iosVersion.major, iosVersion.minor, 18, 4) < 0
    );
    const isMobileWeb = !isNative && MOBILE_USER_AGENT.test(String(userAgent));

    return {
        platform: normalizedPlatform,
        isNative: Boolean(isNative),
        isMobileWeb,
        isIOS,
        iosVersion,
        isLegacyAppleMaps
    };
}

function propertyKey(property, index) {
    return property?.address_hash || property?.legacy_hash || property?.id || `stop-${index + 1}`;
}

function propertyAddress(property = {}) {
    const street = property.full_address
        || property.address
        || `${property.house_number || ''} ${property.street_name || ''}`.trim();
    return [
        street,
        property.city,
        [property.state, property.zip_code || property.zip].filter(Boolean).join(' ')
    ].filter(Boolean).join(', ').trim();
}

function validCoordinates(lat, lng) {
    if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') {
        return false;
    }
    const latitude = Number(lat);
    const longitude = Number(lng);
    return Number.isFinite(latitude)
        && Number.isFinite(longitude)
        && latitude >= -90
        && latitude <= 90
        && longitude >= -180
        && longitude <= 180;
}

function formatCoordinate(value) {
    return Number(value).toFixed(6).replace(/\.?0+$/, '');
}

export function normalizeNavigationStop(property, index = 0) {
    if (!property || typeof property !== 'object') {
        throw new TypeError(`Route stop ${index + 1} is missing.`);
    }

    const address = propertyAddress(property);
    const hasCoordinates = validCoordinates(property.lat, property.lng);
    if (!hasCoordinates && !address) {
        throw new TypeError(`Route stop ${propertyKey(property, index)} has no usable coordinates or address.`);
    }

    return {
        ...property,
        navigationKey: propertyKey(property, index),
        navigationAddress: address,
        navigationLocation: hasCoordinates
            ? `${formatCoordinate(property.lat)},${formatCoordinate(property.lng)}`
            : address
    };
}

function statusForProperty(property, statusByHash) {
    const key = property?.address_hash || property?.legacy_hash || property?.id;
    if (typeof statusByHash === 'function') return statusByHash(property);
    if (statusByHash instanceof Map) return statusByHash.get(key);
    return key ? statusByHash?.[key] : undefined;
}

export function selectRemainingTodoStops(properties = [], statusByHash = {}) {
    return properties.filter((property) => {
        const status = statusForProperty(property, statusByHash);
        return !status || status === 'ELIGIBLE';
    });
}

export function getNavigationSessionProgress(session, remainingProperties = []) {
    const plan = session?.plan;
    const batchIndex = Number(session?.batchIndex);
    const currentBatch = Number.isInteger(batchIndex) ? plan?.batches?.[batchIndex] : null;
    if (!currentBatch) {
        return {
            active: false,
            currentBatch: null,
            remainingStops: [],
            continuationStops: [],
            canResume: false,
            canAdvance: false,
        };
    }

    const remainingKeys = new Set(
        remainingProperties.map((property, index) => propertyKey(property, index))
    );
    const remainingStops = currentBatch.stops.filter((stop) => remainingKeys.has(stop.navigationKey));
    const currentBatchKeys = new Set(currentBatch.stops.map((stop) => stop.navigationKey));
    const continuationStops = remainingProperties.filter(
        (property, index) => !currentBatchKeys.has(propertyKey(property, index))
    );

    return {
        active: true,
        currentBatch,
        remainingStops,
        continuationStops,
        canResume: remainingStops.length > 0,
        canAdvance: remainingStops.length === 0 && continuationStops.length > 0,
    };
}

function normalizedTravelMode(mode, provider) {
    if (!mode || !VALID_TRAVEL_MODES.has(mode)) return null;
    if (provider === 'google' && mode === 'cycling') return 'bicycling';
    if (provider === 'apple' && mode === 'bicycling') return 'cycling';
    return mode;
}

export function buildGoogleMapsRouteUrl(stops, { travelMode = null } = {}) {
    if (!Array.isArray(stops) || stops.length === 0) {
        throw new TypeError('At least one route stop is required.');
    }

    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('dir_action', 'navigate');
    url.searchParams.set('destination', stops[stops.length - 1].navigationLocation);
    if (stops.length > 1) {
        url.searchParams.set('waypoints', stops.slice(0, -1).map(stop => stop.navigationLocation).join('|'));
    }
    const mode = normalizedTravelMode(travelMode, 'google');
    if (mode) url.searchParams.set('travelmode', mode);
    return url.toString();
}

export function buildAppleUnifiedRouteUrl(stops, { travelMode = null, startDelaySeconds } = {}) {
    if (!Array.isArray(stops) || stops.length === 0) {
        throw new TypeError('At least one route stop is required.');
    }

    const url = new URL('https://maps.apple.com/directions');
    url.searchParams.set('destination', stops[stops.length - 1].navigationLocation);
    stops.slice(0, -1).forEach(stop => url.searchParams.append('waypoint', stop.navigationLocation));
    const mode = normalizedTravelMode(travelMode, 'apple');
    if (mode) url.searchParams.set('mode', mode);
    if (Number.isInteger(startDelaySeconds) && startDelaySeconds >= 0) {
        url.searchParams.set('start', String(startDelaySeconds));
    }
    return url.toString();
}

export function buildAppleLegacyRouteUrl(stops, { travelMode = null } = {}) {
    if (!Array.isArray(stops) || stops.length !== 1) {
        throw new TypeError('Legacy Apple Maps links support exactly one destination.');
    }

    const url = new URL('https://maps.apple.com/');
    url.searchParams.set('daddr', stops[0].navigationLocation);
    const mode = normalizedTravelMode(travelMode, 'apple');
    if (mode === 'driving') url.searchParams.set('dirflg', 'd');
    if (mode === 'walking') url.searchParams.set('dirflg', 'w');
    if (mode === 'transit') url.searchParams.set('dirflg', 'r');
    return url.toString();
}

function buildContiguousBatches(stops, { maxStops, maxUrlLength, buildUrl }) {
    const batches = [];
    let startIndex = 0;

    while (startIndex < stops.length) {
        let endIndex = Math.min(stops.length, startIndex + maxStops);
        let candidateStops = null;
        let candidateUrl = '';

        while (endIndex > startIndex) {
            candidateStops = stops.slice(startIndex, endIndex);
            candidateUrl = buildUrl(candidateStops);
            if (candidateUrl.length <= maxUrlLength) break;
            endIndex -= 1;
        }

        if (endIndex === startIndex || !candidateStops || candidateUrl.length > maxUrlLength) {
            throw new RangeError(`Route stop ${stops[startIndex].navigationKey} exceeds the ${maxUrlLength}-character navigation URL limit.`);
        }

        batches.push({
            startIndex,
            endIndex: endIndex - 1,
            stops: candidateStops,
            url: candidateUrl
        });
        startIndex = endIndex;
    }

    return batches.map((batch, index) => ({
        ...batch,
        index,
        number: index + 1,
        totalBatches: batches.length
    }));
}

export function buildRouteNavigationPlan(properties = [], {
    provider = 'apple',
    environment = detectNavigationEnvironment(),
    travelMode = null,
    startDelaySeconds,
    maxUrlLength = MAX_NAVIGATION_URL_LENGTH,
    appleMaxStops = APPLE_UNIFIED_MAX_STOPS
} = {}) {
    const normalizedProvider = provider === 'google' ? 'google' : 'apple';
    const stops = properties.map(normalizeNavigationStop);
    if (stops.length === 0) {
        return {
            provider: normalizedProvider,
            format: normalizedProvider === 'google' ? 'google-universal' : 'apple-unified',
            usesCurrentLocation: true,
            stopCount: 0,
            batches: []
        };
    }

    let format;
    let maxStops;
    let buildUrl;

    if (normalizedProvider === 'google') {
        format = 'google-universal';
        maxStops = environment?.isMobileWeb
            ? GOOGLE_MOBILE_WEB_MAX_STOPS
            : GOOGLE_NATIVE_OR_DESKTOP_MAX_STOPS;
        buildUrl = batchStops => buildGoogleMapsRouteUrl(batchStops, { travelMode });
    } else if (environment?.isLegacyAppleMaps) {
        format = 'apple-legacy';
        maxStops = 1;
        buildUrl = batchStops => buildAppleLegacyRouteUrl(batchStops, { travelMode });
    } else {
        format = 'apple-unified';
        maxStops = appleMaxStops;
        buildUrl = batchStops => buildAppleUnifiedRouteUrl(batchStops, { travelMode, startDelaySeconds });
    }

    const batches = buildContiguousBatches(stops, {
        maxStops,
        maxUrlLength,
        buildUrl
    });

    return {
        provider: normalizedProvider,
        format,
        usesCurrentLocation: true,
        stopCount: stops.length,
        batches
    };
}
