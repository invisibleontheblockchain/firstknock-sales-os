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
    const destination = cleanAddress ? encodeURIComponent(cleanAddress) : encodeURIComponent(`${lat},${lng}`);

    if (app === 'google') {
        return `https://www.google.com/maps/search/?api=1&query=${destination}`;
    }

    return `https://maps.apple.com/?q=${destination}`;
}

export function openInMaps(lat, lng, address, app = 'apple') {
    const url = getNavigationUrl(lat, lng, address, app);
    window.location.href = url;
}