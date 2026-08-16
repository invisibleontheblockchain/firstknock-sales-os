import React, { useEffect } from 'react';
import L from 'leaflet';
import { TileLayer, useMap } from 'react-leaflet';
import { leafletLayer } from 'protomaps-leaflet';
import { getCanvasBasemapConfiguration } from '@/components/canvas/canvasBasemapConfiguration';
import { CANVAS_CARTO_FLAVOR } from '@/components/canvas/canvasCartoFlavor';

const TILE_PERFORMANCE = Object.freeze({
  keepBuffer: 3,
  updateWhenZooming: true,
  updateWhenIdle: false,
  maxNativeZoom: 19,
  maxZoom: 20,
});

export { getCanvasBasemapConfiguration } from '@/components/canvas/canvasBasemapConfiguration';

// The dim has to be applied to the whole tile pane, not to each tile. A filter
// on individual tiles promotes every tile to its own compositing layer, which
// makes the seams between them show up as a visible grid of squares.
function useCanvasBasemapTone(enabled) {
  const map = useMap();

  useEffect(() => {
    if (!enabled) return undefined;
    const container = map.getContainer();
    container.classList.add('fk-canvas-basemap-tone');
    return () => container.classList.remove('fk-canvas-basemap-tone');
  }, [enabled, map]);
}

function CanvasPmtilesLayer({ config }) {
  const map = useMap();

  useEffect(() => {
    // This Canvas-only compatibility layer lets the existing Leaflet map read
    // one static vector archive directly from object storage. Precision keeps
    // its current map implementation and dependencies.
    const globalObject = typeof window === 'undefined' ? globalThis : window;
    const previousLeaflet = globalObject.L;
    globalObject.L = L;
    const layer = leafletLayer({
      url: config.url,
      // Our Carto theme is a full palette object; the built-in flavors are
      // referenced by name.
      flavor: config.flavor === 'carto' ? CANVAS_CARTO_FLAVOR : config.flavor,
      lang: 'en',
      attribution: config.attribution,
      noWrap: true,
      keepBuffer: TILE_PERFORMANCE.keepBuffer,
      updateWhenZooming: TILE_PERFORMANCE.updateWhenZooming,
      updateWhenIdle: TILE_PERFORMANCE.updateWhenIdle,
      maxZoom: TILE_PERFORMANCE.maxZoom,
    });
    layer.addTo(map);
    return () => {
      layer.remove();
      if (previousLeaflet === undefined) delete globalObject.L;
      else globalObject.L = previousLeaflet;
    };
  }, [config.attribution, config.flavor, config.url, map]);

  return null;
}

export default function CanvasBaseMapTiles({ satellite = false }) {
  const config = getCanvasBasemapConfiguration({ satellite, env: import.meta.env });
  const showingSatellite = satellite && config.satelliteAvailable;
  useCanvasBasemapTone(Boolean(config.url) && !showingSatellite);
  if (!config.url) return null;
  if (config.mode === 'pmtiles') return <CanvasPmtilesLayer config={config} />;
  return (
    <TileLayer
      key={`canvas-basemap-${satellite && config.satelliteAvailable ? 'satellite' : 'streets'}`}
      url={config.url}
      attribution={config.attribution}
      crossOrigin
      {...TILE_PERFORMANCE}
    />
  );
}