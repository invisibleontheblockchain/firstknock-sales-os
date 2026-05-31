import React from 'react';
import { Polygon, Tooltip } from 'react-leaflet';

export default function CanvasZoneLayers({ zones = [] }) {
  return (
    <>
      {zones.filter((zone) => zone.geometry?.length > 2).map((zone) => (
        <Polygon
          key={`canvas-zone-${zone.zone_number}`}
          positions={zone.geometry}
          pathOptions={{
            color: zone.color || '#A855F7',
            fillColor: zone.color || '#A855F7',
            fillOpacity: 0.23,
            opacity: 0.95,
            weight: 3,
          }}
        >
          <Tooltip permanent direction="center" className="route-number-tooltip">
            <div
              className="px-2 py-1 rounded-full text-[11px] font-black border shadow-lg"
              style={{ background: zone.color || '#A855F7', color: '#050505', borderColor: 'rgba(255,255,255,0.8)' }}
            >
              {zone.assigned_to_name || zone.name || `Zone ${zone.zone_number}`}
            </div>
          </Tooltip>
        </Polygon>
      ))}
    </>
  );
}