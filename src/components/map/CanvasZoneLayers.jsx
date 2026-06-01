import React from 'react';
import L from 'leaflet';
import { LayerGroup, Marker, Polygon, Tooltip } from 'react-leaflet';
import CanvasBoundaryHandles from './CanvasBoundaryHandles';

function dropIcon(color) {
  return L.divIcon({
    className: 'canvas-drop-icon',
    html: `<div style="width:20px;height:20px;border-radius:999px;background:${color};border:4px solid #ffffff;box-shadow:0 0 0 2px #050505,0 8px 18px rgba(0,0,0,.45)"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function labelIcon(zone, label) {
  const color = zone.color || '#A855F7';
  return L.divIcon({
    className: 'canvas-zone-label',
    html: `<div style="border:1px solid ${color};background:rgba(5,5,8,.92);border-radius:12px;overflow:hidden;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.35);min-width:76px"><div style="background:${color};color:#050505;font-size:10px;font-weight:900;padding:2px 8px">Z${zone.zone_number} · ${zone.estimated_doors || '?'} doors</div><div style="color:white;font-size:10px;font-weight:700;padding:4px 8px;max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div></div>`,
    iconSize: [90, 38],
    iconAnchor: [45, 19],
  });
}

export default function CanvasZoneLayers({ zones = [] }) {
  return (
    <LayerGroup>
      {zones.filter((zone) => (zone.parts || [zone.geometry]).some((part) => part?.length > 2)).map((zone) => {
        const label = zone.assigned_to_name || zone.assignments?.filter(Boolean).join(' + ') || 'Unassigned';
        const parts = zone.parts?.length ? zone.parts : [zone.geometry];
        const color = zone.color || '#A855F7';
        return (
          <LayerGroup key={`canvas-zone-${zone.zone_number}`}>
            {parts.filter((part) => part?.length > 2).map((part, partIndex) => (
              <Polygon
                key={`canvas-zone-${zone.zone_number}-${partIndex}`}
                positions={part}
                pathOptions={{
                  color: '#050505',
                  fillColor: color,
                  fillOpacity: 0.35,
                  opacity: 0.95,
                  weight: 2,
                }}
              />
            ))}
            {zone.center && <Marker position={zone.center} icon={labelIcon(zone, label)} interactive={false} keyboard={false} />}
            {zone.drop_point && (
              <Marker position={zone.drop_point} icon={dropIcon(color)}>
                <Tooltip direction="top">
                  Drop point — Zone {zone.zone_number}
                </Tooltip>
              </Marker>
            )}
          </LayerGroup>
        );
      })}
      <CanvasBoundaryHandles zones={zones} />
    </LayerGroup>
  );
}