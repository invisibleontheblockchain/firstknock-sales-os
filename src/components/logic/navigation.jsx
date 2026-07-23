import { Capacitor } from '@capacitor/core';
import { buildRouteNavigationPlan, detectNavigationEnvironment } from './routeNavigation';

export function buildFullAddress(property = {}) {
    const street = property.full_address || property.address || `${property.house_number || ''} ${property.street_name || ''}`.trim();
    return [
        street,
        property.city,
        [property.state, property.zip_code || property.zip].filter(Boolean).join(' ')
    ].filter(Boolean).join(', ');
}

export function getRuntimeNavigationEnvironment() {
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    let platform = 'web';
    let isNative = false;
    try {
        platform = Capacitor.getPlatform();
        isNative = Capacitor.isNativePlatform();
    } catch {
        // Browser and test environments can use the web defaults.
    }
    return detectNavigationEnvironment({ userAgent, platform, isNative });
}

export function getRouteNavigationPlan(properties, app = 'apple', options = {}) {
    return buildRouteNavigationPlan(properties, {
        ...options,
        provider: app,
        environment: options.environment || getRuntimeNavigationEnvironment()
    });
}

export function openNavigationBatch(plan, batchIndex = 0) {
    const batch = plan?.batches?.[batchIndex];
    if (!batch?.url) return null;
    window.location.href = batch.url;
    return batch;
}

export function getNavigationUrl(lat, lng, address, app = 'apple', options = {}) {
    const plan = getRouteNavigationPlan([{
        lat,
        lng,
        full_address: typeof address === 'string' ? address.trim() : ''
    }], app, options);
    return plan.batches[0]?.url || '';
}

export function openInMaps(lat, lng, address, app = 'apple', options = {}) {
    const url = getNavigationUrl(lat, lng, address, app, options);
    window.location.href = url;
}
