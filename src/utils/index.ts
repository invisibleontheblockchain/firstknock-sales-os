export function createPageUrl(pageName: string) {
    return '/' + pageName.replace(/ /g, '-');
}

export function openInMaps(lat: number | string, lng: number | string) {
    // Force Apple Maps for iOS/Mac users as requested
    // http://maps.apple.com/ opens the native Maps app on iOS
    window.open(`http://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`, '_blank');
}