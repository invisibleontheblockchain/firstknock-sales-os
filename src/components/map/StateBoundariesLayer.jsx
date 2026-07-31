import React, { useEffect, useState } from 'react';
import { GeoJSON } from 'react-leaflet';

const STATES_GEOJSON_URL = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';

// Cosmetic-only overlay: draws US state outlines so zoomed-out views show
// state lines instead of a single country blob. Hidden once the user is zoomed
// into a working territory so it never clutters street-level work.
export default function StateBoundariesLayer({ zoomLevel = 0, maxZoom = 9 }) {
  const [states, setStates] = useState(null);
  const visible = zoomLevel <= maxZoom;

  useEffect(() => {
    if (!visible || states) return;
    let cancelled = false;
    fetch(STATES_GEOJSON_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) setStates(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [visible, states]);

  if (!visible || !states) return null;

  return (
    <GeoJSON
      data={states}
      interactive={false}
      style={{
        color: 'rgba(255,255,255,0.45)',
        weight: 1,
        opacity: 1,
        fill: false,
      }}
    />
  );
}