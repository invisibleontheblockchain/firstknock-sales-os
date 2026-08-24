import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Polygon, Polyline, CircleMarker, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABEL_TILES = 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';

function FlyToTarget({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], 13, { duration: 1.2 });
  }, [map, target]);
  return null;
}

// Freehand lasso capture, matching the in-app draw tool: press and drag to trace
// the territory, release to close the shape.
function FreehandCapture({ drawing, onAddPoint, onStrokeStart, onStrokeEnd }) {
  const map = useMap();

  useEffect(() => {
    if (!drawing) return undefined;
    const container = map.getContainer();
    let active = false;
    let lastSample = 0;

    map.dragging.disable();
    map.doubleClickZoom.disable();

    const toLatLng = (event) => {
      const source = event.touches?.[0] || event;
      const rect = container.getBoundingClientRect();
      return map.containerPointToLatLng([source.clientX - rect.left, source.clientY - rect.top]);
    };

    const addFrom = (event) => {
      const { lat, lng } = toLatLng(event);
      onAddPoint({ lat, lng });
    };

    const start = (event) => {
      active = true;
      lastSample = Date.now();
      event.preventDefault();
      onStrokeStart();
      addFrom(event);
    };

    const move = (event) => {
      if (!active) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastSample < 40) return;
      lastSample = now;
      addFrom(event);
    };

    const end = () => {
      if (!active) return;
      active = false;
      onStrokeEnd();
    };

    container.addEventListener('mousedown', start);
    container.addEventListener('mousemove', move);
    container.addEventListener('mouseup', end);
    container.addEventListener('mouseleave', end);
    container.addEventListener('touchstart', start, { passive: false });
    container.addEventListener('touchmove', move, { passive: false });
    container.addEventListener('touchend', end);

    return () => {
      container.removeEventListener('mousedown', start);
      container.removeEventListener('mousemove', move);
      container.removeEventListener('mouseup', end);
      container.removeEventListener('mouseleave', end);
      container.removeEventListener('touchstart', start);
      container.removeEventListener('touchmove', move);
      container.removeEventListener('touchend', end);
      map.dragging.enable();
      map.doubleClickZoom.enable();
    };
  }, [drawing, map, onAddPoint, onStrokeStart, onStrokeEnd]);

  return null;
}

export default function FindMap({ center, drawing, polygonPoints, closed, teaser, onAddPoint, onStrokeStart, onStrokeEnd }) {
  const latlngs = polygonPoints.map((p) => [p.lat, p.lng]);

  return (
    <MapContainer
      center={[39.5, -84.5]}
      zoom={5}
      zoomControl={false}
      attributionControl={false}
      className="absolute inset-0 z-0"
      style={{ background: '#0b0b0b', cursor: drawing ? 'crosshair' : undefined }}
    >
      <TileLayer url={SATELLITE_TILES} keepBuffer={3} updateWhenZooming updateWhenIdle={false} maxNativeZoom={19} maxZoom={20} />
      <TileLayer url={LABEL_TILES} zIndex={100} keepBuffer={3} updateWhenZooming updateWhenIdle={false} maxNativeZoom={19} maxZoom={20} />
      <FlyToTarget target={center} />
      <FreehandCapture
        drawing={drawing}
        onAddPoint={onAddPoint}
        onStrokeStart={onStrokeStart}
        onStrokeEnd={onStrokeEnd}
      />

      {latlngs.length >= 2 && !closed && (
        <Polyline positions={latlngs} pathOptions={{ color: '#39FF4A', weight: 2.5 }} />
      )}
      {latlngs.length >= 3 && closed && (
        <Polygon
          positions={latlngs}
          pathOptions={{ color: '#2EEB57', weight: 2.5, fillColor: '#2EEB57', fillOpacity: 0.12 }}
        />
      )}
      {closed && teaser.map((p, i) => (
        <CircleMarker
          key={`teaser-${i}`}
          center={[p.lat, p.lng]}
          radius={6}
          pathOptions={{ color: '#2EEB57', weight: 1.5, fillColor: '#2EEB57', fillOpacity: 0.55 }}
        />
      ))}
    </MapContainer>
  );
}