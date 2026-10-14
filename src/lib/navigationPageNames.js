export function getNavigationPageNames(pageModules) {
    return Object.keys(pageModules).map((path) => path.split('/').pop().replace(/\.(jsx|js)$/, ''));
}

export function matchNavigationPage(pathname, pageNames) {
    if (!pathname || pathname === '/') return null;
    const segment = pathname.replace(/^\//, '').split('/')[0].toLowerCase();
    return pageNames.find((name) => name.toLowerCase() === segment) || null;
}
