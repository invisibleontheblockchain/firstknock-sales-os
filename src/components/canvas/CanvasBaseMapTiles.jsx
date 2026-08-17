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

const LIGHT_VARIANT_CLASSES = Object.freeze({
  light_soft: 'fk-canvas-light-soft',
  light_warm: 'fk-canvas-light-warm',
  light_cool: 'fk-canvas-light-cool',
  light_vivid: 'fk-canvas-light-vivid',
  light_contrast: 'fk-canvas-light-contrast',
  light_mono: 'fk-canvas-light-mono',
});

export { getCanvasBasemapConfiguration } from '@/components/canvas/canvasBasemapConfiguration';

function CanvasPmtilesLayer({ config, tileClass }) {
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
      className: tileClass,
    });
    layer.addTo(map);
    return () => {
      layer.remove();
      if (previousLeaflet === undefined) delete globalObject.L;
      else globalObject.L = previousLeaflet;
    };
  }, [config.attribution, config.flavor, config.url, map, tileClass]);

  return null;
}

// theme mirrors the Map Style choice in Map Settings: light, dark, satellite, hybrid.
export default function CanvasBaseMapTiles({ theme = 'light', satellite = false }) {
  const config = getCanvasBasemapConfiguration({ theme, satellite, env: import.meta.env });
  const tileClass = LIGHT_VARIANT_CLASSES[theme] || '';
  if (!config.url) return null;
  if (config.mode === 'pmtiles') return <CanvasPmtilesLayer key={`${theme}-${config.url}`} config={config} tileClass={tileClass} />;
  return (
    <TileLayer
      key={`canvas-basemap-${theme}-${config.url}`}
      url={config.url}
      attribution={config.attribution}
      className={tileClass}
      crossOrigin
      {...TILE_PERFORMANCE}
    />
  );
}