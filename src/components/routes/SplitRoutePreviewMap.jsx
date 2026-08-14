import React, { useEffect, useMemo } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
} from 'react-leaflet';
import { CARTO_ATTRIBUTION } from '@/components/map/mapAttribution';
import '@/components/map/leafletPatches';

const ROUTE_COLORS = [
  '#39FF4A', '#60A5FA', '#F59E0B', '#F472B6', '#A78BFA',
  '#22D3EE', '#FB7185', '#84CC16', '#F97316', '#2DD4BF',
];

export function previewColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

function FitSplitPreview({ routes }) {
  const map = useMap();
  const points = useMemo(() => routes.flatMap((route) => (
    route.stops.map((stop) => [Number(stop.lat), Number(stop.lng)])
  )), [routes]);
  const signature = points.map((point) => point.join(',')).join('|');

  useEffect(() => {
    if (!points.length) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      if (!map?._loaded || !map?._container?.isConnected || !map?._mapPane) return;
      if (points.length === 1) map.setView(points[0], 16, { animate: false });
      else map.fitBounds(points, { padding: [18, 18], maxZoom: 16, animate: false });
      if (map._loaded && map._container?.isConnected && map._mapPane) {
        map.invalidateSize({ animate: false, pan: false });
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [map, signature]);

  return null;
}

/**
 * Split preview map. Zooming and panning are enabled so a manager can inspect
 * the proposed areas in both the inline and enlarged views.
 */
export default function SplitRoutePreviewMap({ routes, className = 'h-full w-full' }) {
  const firstStop = routes[0]?.stops?.[0];
  const center = firstStop
    ? [Number(firstStop.lat), Number(firstStop.lng)]
    : [39.5, -98.35];

  return (
    <MapContainer
      center={center}
      zoom={13}
      className={className}
      zoomControl
      scrollWheelZoom
      attributionControl
      preferCanvas={false}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution={CARTO_ATTRIBUTION}
      />
      <FitSplitPreview routes={routes} />
      {routes.map((route, routeIndex) => {
        const color = previewColor(routeIndex);
        const positions = route.stops.map((stop) => [Number(stop.lat), Number(stop.lng)]);
        return (
          <React.Fragment key={route.code}>
            {positions.length > 1 && (
              <Polyline positions={positions} pathOptions={{ color, opacity: 0.72, weight: 3 }} />
            )}
            {positions.map((position, stopIndex) => (
              <CircleMarker
                key={`${route.code}-${stopIndex}`}
                center={position}
                radius={3.5}
                pathOptions={{ color: '#070707', fillColor: color, fillOpacity: 1, weight: 1 }}
              />
            ))}
          </React.Fragment>
        );
      })}
    </MapContainer>
  );
}