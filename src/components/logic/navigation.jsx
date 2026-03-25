export function getNavigationUrl(lat, lng, address, app = 'apple') {
    const destination = address 
        ? encodeURIComponent(address) 
        : `${lat},${lng}`;

    if (app === 'google') {
        // Google Maps Universal Link
        return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
    } else {
        // Apple Maps Universal Link
        return `https://maps.apple.com/?daddr=${destination}&dirflg=d`;
    }
}

export function openInMaps(lat, lng, address, app = 'apple') {
    const url = getNavigationUrl(lat, lng, address, app);
    window.location.href = url;
}