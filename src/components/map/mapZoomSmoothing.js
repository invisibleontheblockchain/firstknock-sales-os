// While a zoom is in progress Leaflet stretches the previous level's tiles
// until the new level's tiles arrive. Leaflet's own CSS tells Safari to scale
// tiles with -webkit-optimize-contrast (nearest neighbour), so mid-pinch the
// owner's iPhone showed hard square blocks until the new tiles landed. From a
// zoom's start until the new view's imagery has loaded, tiles scale smoothly
// instead (index.css); at rest they keep Leaflet's look.
export const ZOOM_SMOOTHING_CLASS = 'fk-map-zooming';

export function attachZoomSmoothing(map, {
    maxSettleMs = 4000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    const container = map.getContainer();
    let zooming = false;
    let tilesPending = false;
    let timer = null;
    const cancelTimer = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
    };
    const finish = () => {
        cancelTimer();
        container.classList.remove(ZOOM_SMOOTHING_CLASS);
    };
    const onZoomStart = () => {
        cancelTimer();
        zooming = true;
        container.classList.add(ZOOM_SMOOTHING_CLASS);
    };
    const onZoomEnd = () => {
        zooming = false;
        cancelTimer();
        // Nothing left to load: the new tiles are already on screen.
        if (!tilesPending) { finish(); return; }
        // A tile that never settles must not leave the map in zoom mode.
        timer = setTimer(finish, maxSettleMs);
    };
    map.on('zoomstart', onZoomStart);
    map.on('zoomend', onZoomEnd);
    return {
        tilesLoading() { tilesPending = true; },
        tilesLoaded() {
            tilesPending = false;
            if (!zooming && container.classList.contains(ZOOM_SMOOTHING_CLASS)) finish();
        },
        detach() {
            map.off('zoomstart', onZoomStart);
            map.off('zoomend', onZoomEnd);
            finish();
        },
    };
}
