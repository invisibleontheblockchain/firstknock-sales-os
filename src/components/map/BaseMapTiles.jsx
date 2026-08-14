import React from 'react';
import { TileLayer } from 'react-leaflet';

const BASEMAP_URLS = {
    satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    hybrid: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
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
    keepBuffer: 4,
    updateWhenZooming: false,
    maxNativeZoom: 19,
    maxZoom: 20,
};

export default function BaseMapTiles({ mapTheme }) {
    const showLabels = mapTheme === 'hybrid' || mapTheme === 'satellite';

    return (
        <>
            <TileLayer
                key={`basemap-${mapTheme}`}
                url={BASEMAP_URLS[mapTheme] || BASEMAP_URLS.dark}
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