import React, { useEffect } from 'react';
import { TileLayer, useMap } from 'react-leaflet';
import CanvasBaseMapTiles from '@/components/canvas/CanvasBaseMapTiles';
import MapAttributionControl from '@/components/map/MapAttributionControl';
import { CARTO_ATTRIBUTION, ESRI_IMAGERY_ATTRIBUTION } from '@/components/map/mapAttribution';

const BASEMAP_URLS = {
    satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    hybrid: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
    streets: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
    terrain: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    minimal: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
};

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

const LABEL_URL = "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f";

// Retain visited tiles for reverse pans; load the new grid during zoom while
// the previous imagery stays visible. Deep zoom scales the provider's highest
// native level. These settings apply to desktop and installed PWAs.
const TILE_PERF = {
    keepBuffer: 3,
    // Zooming out used to leave the whole screen black until the animation
    // landed, because Leaflet waited for idle before requesting the new grid.
    // Requesting while zooming keeps imagery on screen the whole way.
    updateWhenZooming: true,
    updateWhenIdle: false,
    maxNativeZoom: 19,
    maxZoom: 20,
};

function MapBackdrop({ mapTheme }) {
    const map = useMap();
    useEffect(() => {
        const container = map.getContainer();
        container.style.background = BASEMAP_BACKDROP[mapTheme] || BASEMAP_BACKDROP.dark;
    }, [map, mapTheme]);
    return null;
}

export default function BaseMapTiles({ mapTheme, routeMode = 'precision' }) {
    const precisionTheme = mapTheme.startsWith('light_') ? 'light' : mapTheme;
    const showLabels = mapTheme === 'hybrid' || mapTheme === 'satellite';

    // Canvas honours the same Map Style choices; only the street source differs.
    if (routeMode === 'canvas') return (
        <>
            <MapAttributionControl />
            <MapBackdrop mapTheme={mapTheme} />
            <CanvasBaseMapTiles theme={mapTheme} />
            {showLabels && (
                <TileLayer
                    key="canvas-basemap-labels"
                    url={LABEL_URL}
                    attribution={CARTO_ATTRIBUTION}
                    zIndex={100}
                    {...TILE_PERF}
                />
            )}
        </>
    );

    return (
        <>
            <MapAttributionControl />
            <MapBackdrop mapTheme={mapTheme} />
            <TileLayer
                key={BASEMAP_URLS[precisionTheme] || BASEMAP_URLS.dark}
                url={BASEMAP_URLS[precisionTheme] || BASEMAP_URLS.dark}
                attribution={['satellite', 'hybrid', 'terrain'].includes(precisionTheme) ? ESRI_IMAGERY_ATTRIBUTION : CARTO_ATTRIBUTION}
                {...TILE_PERF}
            />
            {showLabels && (
                <TileLayer
                    key="basemap-labels"
                    url={LABEL_URL}
                    attribution={CARTO_ATTRIBUTION}
                    zIndex={100}
                    {...TILE_PERF}
                />
            )}
        </>
    );
}