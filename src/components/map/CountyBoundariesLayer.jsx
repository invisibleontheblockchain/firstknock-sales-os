import React, { useEffect, useMemo, useState } from 'react';
import { GeoJSON, Tooltip, useMap, useMapEvents } from 'react-leaflet';

/**
 * County outlines for the working area.
 *
 * Only the counties whose bounding box touches the current view are drawn, so a
 * national file never turns into 3,000 polygons on screen. Non-interactive, so it
 * can never swallow a tap meant for a property pin.
 */
const COUNTIES_GEOJSON_URL = 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';
const LABEL_MIN_ZOOM = 8;

let countiesPromise = null;
function loadCounties() {
  if (!countiesPromise) {
    countiesPromise = fetch(COUNTIES_GEOJSON_URL)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }
  return countiesPromise;
}

/** [minLng, minLat, maxLng, maxLat] of any polygon/multipolygon feature. */
function featureBbox(geometry) {
  const rings = geometry?.type === 'MultiPolygon'
    ? geometry.coordinates.flat()
    : geometry?.coordinates || [];
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  rings.flat().forEach(([lng, lat]) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  });
  return [minLng, minLat, maxLng, maxLat];
}

export default function CountyBoundariesLayer() {
  const map = useMap();
  const [counties, setCounties] = useState(null);
  const [view, setView] = useState(() => ({ bounds: map.getBounds(), zoom: map.getZoom() }));

  useMapEvents({
    moveend: () => setView({ bounds: map.getBounds(), zoom: map.getZoom() }),
    zoomend: () => setView({ bounds: map.getBounds(), zoom: map.getZoom() }),
  });

  useEffect(() => {
    let cancelled = false;
    loadCounties().then((data) => {
      if (!cancelled && data?.features) setCounties(data.features);
    });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (!counties || !view.bounds) return [];
    const west = view.bounds.getWest();
    const east = view.bounds.getEast();
    const south = view.bounds.getSouth();
    const north = view.bounds.getNorth();
    return counties.filter((feature) => {
      const [minLng, minLat, maxLng, maxLat] = featureBbox(feature.geometry);
      return minLng <= east && maxLng >= west && minLat <= north && maxLat >= south;
    }).slice(0, 60);
  }, [counties, view.bounds]);

  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((feature) => (
        <GeoJSON
          key={feature.id || feature.properties?.GEO_ID}
          data={feature}
          interactive={false}
          style={{ color: '#7dd3fc', weight: 1.5, opacity: 0.7, fill: false, dashArray: '10,6' }}
        >
          {view.zoom >= LABEL_MIN_ZOOM && feature.properties?.NAME && (
            <Tooltip permanent direction="center" className="zip-label-tooltip">
              <span style={{ color: '#7dd3fc', fontWeight: 800, fontSize: '11px', letterSpacing: '0.5px' }}>
                {feature.properties.NAME} County
              </span>
            </Tooltip>
          )}
        </GeoJSON>
      ))}
    </>
  );
}