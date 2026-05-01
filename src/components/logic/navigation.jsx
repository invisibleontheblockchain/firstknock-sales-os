export function buildFullAddress(property = {}) {
    const street = property.full_address || `${property.house_number || ''} ${property.street_name || ''}`.trim();
    return [
        street,
        property.city,
        [property.state, property.zip_code].filter(Boolean).join(' ')
    ].filter(Boolean).join(', ');
}

export function getNavigationUrl(lat, lng, address, app = 'apple') {
    const cleanAddress = typeof address === 'string' ? address.trim() : '';
    const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const coordinateText = hasCoords ? `${lat},${lng}` : '';
    const destination = encodeURIComponent(coordinateText || cleanAddress);
    const label = cleanAddress ? encodeURIComponent(cleanAddress) : destination;

    if (app === 'google') {
        return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    }

    return `https://maps.apple.com/?daddr=${destination}&q=${label}`;
}

export function openInMaps(lat, lng, address, app = 'apple') {
    const url = getNavigationUrl(lat, lng, address, app);
    window.location.href = url;
}