export function getCustomRangeRevealScrollTop({
    scrollTop,
    viewportTop,
    viewportBottom,
    panelTop,
    panelBottom,
    padding = 12,
}) {
    const panelIsVisible = panelTop >= viewportTop + padding &&
        panelBottom <= viewportBottom - padding;
    if (panelIsVisible) return null;

    return Math.max(0, scrollTop + panelTop - viewportTop - padding);
}
