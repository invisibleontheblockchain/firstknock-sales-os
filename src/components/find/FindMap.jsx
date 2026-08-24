import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Polygon, Polyline, CircleMarker, useMap, useMapEvents } from 'react-leaflet';
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

function DrawCapture({ drawing, onAddPoint }) {
  useMapEvents({
    click(e) {
      if (drawing) onAddPoint({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

export default function FindMap({ center, drawing, polygonPoints, closed, teaser, onAddPoint }) {
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
      <DrawCapture drawing={drawing} onAddPoint={onAddPoint} />

      {latlngs.length >= 2 && !closed && (
        <Polyline positions={latlngs} pathOptions={{ color: '#39FF4A', weight: 2, dashArray: '6 6' }} />
      )}
      {latlngs.length >= 3 && closed && (
        <Polygon
          positions={latlngs}
          pathOptions={{ color: '#2EEB57', weight: 2.5, fillColor: '#2EEB57', fillOpacity: 0.12 }}
        />
      )}
      {!closed && polygonPoints.map((p, i) => (
        <CircleMarker
          key={`vertex-${i}`}
          center={[p.lat, p.lng]}
          radius={5}
          pathOptions={{ color: '#39FF4A', weight: 2, fillColor: '#000', fillOpacity: 1 }}
        />
      ))}
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