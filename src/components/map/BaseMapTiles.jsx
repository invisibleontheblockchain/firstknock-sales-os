import React, { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import RecoveringTileLayer from '@/components/map/RecoveringTileLayer';
import ZoomOutBackdrop from '@/components/map/ZoomOutBackdrop';
import MapAttributionControl from '@/components/map/MapAttributionControl';
import { CARTO_ATTRIBUTION, ESRI_IMAGERY_ATTRIBUTION } from '@/components/map/mapAttribution';
import { BASEMAP_URLS, LABEL_URL, basemapTileOptions, precisionThemeFor, showsLabelsFor } from '@/components/map/basemapUrls';

// Canvas's vector basemap is ~40 KB gzipped and only
// Canvas mode draws it, so Precision maps no longer download it.
const CanvasBaseMapTiles = React.lazy(() => import('@/components/canvas/CanvasBaseMapTiles'));

// The map container is black, so any hairline gap Leaflet leaves between tiles
// at fractional zoom reads as a dark grid over light imagery. Painting the
// container in the basemap's own base colour makes those seams invisible
// without touching zoom behaviour or the tiles themselves.
const BASEMAP_BACKDROP = {
    satellite: '#0b1a26',
    hybrid: '#0b1a26',
    light: '#f2f0eb',
    dark: '#0b0b0b',
    streets: '#f8f4f0',
    terrain: '#e9e5dc',
    minimal: '#f8f4f0',
};

// Desktop retains visited tiles for reverse pans (keepBuffer: 3) and loads the
// new grid during zoom while the previous imagery stays visible
// (updateWhenZooming: true, updateWhenIdle: false); zooming out used to leave
// the screen black until the animation landed. Phones and tablets use a
// smaller budget so Safari does not run out of layer memory and paint tiles
// black; the zoom-out backdrop covers their gaps (basemapTileOptions).
const TILE_PERF = basemapTileOptions({ phone: Boolean(L.Browser.mobile || L.Browser.touch) });

const LIGHT_BACKDROPS = new Set(['light', 'streets', 'terrain', 'minimal']);

// Until the first basemap tile paints, the container showed a flat panel in
// the backdrop colour, which read as a broken screen on first open. It now
// shows a loading skeleton in the basemap's own tone (index.css); the tile
// pane draws over it as soon as imagery arrives.
export function mapBackdropClasses(mapTheme, waiting) {
    if (!waiting) return [];
    return ['fk-map-skeleton', LIGHT_BACKDROPS.has(mapTheme) ? 'fk-map-skeleton-light' : 'fk-map-skeleton-dark'];
}

function MapBackdrop({ mapTheme, waiting = false }) {
    const map = useMap();
    useEffect(() => {
        const container = map.getContainer();
        container.style.backgroundColor = BASEMAP_BACKDROP[mapTheme] || BASEMAP_BACKDROP.dark;
        const classes = mapBackdropClasses(mapTheme, waiting);
        classes.forEach((name) => container.classList.add(name));
        return () => classes.forEach((name) => container.classList.remove(name));
    }, [map, mapTheme, waiting]);
    return null;
}

export default function BaseMapTiles({ mapTheme, routeMode = 'precision' }) {
    const precisionTheme = precisionThemeFor(mapTheme);
    const showLabels = showsLabelsFor(mapTheme);

    // Canvas honours the same Map Style choices; only the street source differs.
    if (routeMode === 'canvas') return (
        <>
            <MapAttributionControl />
            <MapBackdrop mapTheme={mapTheme} />
            <React.Suspense fallback={null}><CanvasBaseMapTiles theme={mapTheme} /></React.Suspense>
            {showLabels && (
                <RecoveringTileLayer
                    key="canvas-basemap-labels"
                    recoveryLabel="Map labels"
                    url={LABEL_URL}
                    attribution={CARTO_ATTRIBUTION}
                    zIndex={100}
                    {...TILE_PERF}
                />
            )}
        </>
    );

    return <PrecisionBaseMap mapTheme={mapTheme} precisionTheme={precisionTheme} showLabels={showLabels} />;
}

function PrecisionBaseMap({ mapTheme, precisionTheme, showLabels }) {
    const url = BASEMAP_URLS[precisionTheme] || BASEMAP_URLS.dark;
    // The zoom-out backdrop waits for the first full view of real tiles.
    const [firstViewLoaded, setFirstViewLoaded] = useState(false);
    const [firstTileShown, setFirstTileShown] = useState(false);
    const basemapEvents = useMemo(() => ({
        tileload: () => setFirstTileShown(true),
        load: () => { setFirstTileShown(true); setFirstViewLoaded(true); },
    }), []);
    useEffect(() => {
        // A tile that never settles must not leave zoom-outs without a backdrop.
        const timer = setTimeout(() => setFirstViewLoaded(true), 6000);
        return () => clearTimeout(timer);
    }, []);
    return (
        <>
            <MapAttributionControl />
            <MapBackdrop mapTheme={mapTheme} waiting={!firstTileShown} />
            {firstViewLoaded && <ZoomOutBackdrop url={url} />}
            <RecoveringTileLayer
                key={url}
                url={url}
                attribution={['satellite', 'hybrid', 'terrain'].includes(precisionTheme) ? ESRI_IMAGERY_ATTRIBUTION : CARTO_ATTRIBUTION}
                eventHandlers={basemapEvents}
                {...TILE_PERF}
            />
            {/* Street labels are tiny tiles that arrive first; on their own over an
                empty panel they looked like a broken map, so they follow the imagery. */}
            {showLabels && firstTileShown && (
                <RecoveringTileLayer
                    key="basemap-labels"
                    recoveryLabel="Map labels"
                    url={LABEL_URL}
                    attribution={CARTO_ATTRIBUTION}
                    zIndex={100}
                    {...TILE_PERF}
                />
            )}
        </>
    );
}
