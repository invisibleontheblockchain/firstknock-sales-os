export function createPageUrl(pageName: string) {
    return '/' + pageName.replace(/ /g, '-');
}

export function openInMaps(lat: number | string, lng: number | string) {
    // Force Apple Maps for iOS/Mac users as requested
    // http://maps.apple.com/ opens the native Maps app on iOS
    window.location.href = `http://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;
}

export function formatPropertyAge(soldDate: string | Date): string {
    if (!soldDate) return '';
    const date = new Date(soldDate);
    if (isNaN(date.getTime())) return '';

    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 30) {
        return `${diffDays}d`;
    }

    const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30.44);
    if (diffMonths < 24) {
        return `${Math.floor(diffMonths)}m`;
    }

    const diffYears = diffMonths / 12;
    return `${diffYears.toFixed(1)}y`;
}