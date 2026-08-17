import React, { useEffect } from 'react';
import { TileLayer, useMap } from 'react-leaflet';
import CanvasBaseMapTiles from '@/components/canvas/CanvasBaseMapTiles';

const BASEMAP_URLS = {
    satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    hybrid: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    streets: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    terrain: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    minimal: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
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

const LABEL_URL = "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png";

// Tuning that removes the zoom stutter and the blank/blurry frames:
// - keepBuffer pre-loads a ring of off-screen tiles so panning and zooming
//   reveal already-decoded imagery instead of empty squares.
// - updateWhenZooming stops Leaflet requesting a whole new tile grid on every
//   intermediate frame of the zoom animation; the new level loads once it lands.
// - maxNativeZoom lets deep zoom scale the provider's sharpest tile rather than
//   requesting a level that does not exist and rendering nothing.
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
            <MapBackdrop mapTheme={mapTheme} />
            <CanvasBaseMapTiles theme={mapTheme} />
            {showLabels && (
                <TileLayer
                    key={`canvas-basemap-labels-${mapTheme}`}
                    url={LABEL_URL}
                    attribution=""
                    zIndex={100}
                    {...TILE_PERF}
                />
            )}
        </>
    );

    return (
        <>
            <MapBackdrop mapTheme={mapTheme} />
            <TileLayer
                key={`basemap-${precisionTheme}`}
                url={BASEMAP_URLS[precisionTheme] || BASEMAP_URLS.dark}
                attribution=""
                {...TILE_PERF}
            />
            {showLabels && (
                <TileLayer
                    key={`basemap-labels-${mapTheme}`}
                    url={LABEL_URL}
                    attribution=""
                    zIndex={100}
                    {...TILE_PERF}
                />
            )}
        </>
    );
}