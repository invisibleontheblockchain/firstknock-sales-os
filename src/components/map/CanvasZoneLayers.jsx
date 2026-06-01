import React from 'react';
import L from 'leaflet';
import { Marker, Polygon, Tooltip } from 'react-leaflet';

function dropIcon(color) {
  return L.divIcon({
    className: 'canvas-drop-icon',
    html: `<div style="width:16px;height:16px;border-radius:999px;background:${color};border:3px solid #050505;box-shadow:0 0 0 2px rgba(255,255,255,.8)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function CanvasZoneLayers({ zones = [] }) {
  return (
    <>
      {zones.filter((zone) => zone.geometry?.length > 2).map((zone) => {
        const label = zone.assigned_to_name || zone.assignments?.filter(Boolean).join(' + ') || 'Unassigned';
        return (
          <React.Fragment key={`canvas-zone-${zone.zone_number}`}>
            <Polygon
              positions={zone.geometry}
              pathOptions={{
                color: zone.color || '#A855F7',
                fillColor: zone.color || '#A855F7',
                fillOpacity: zone.assigned_to_name || zone.assignments?.length ? 0.28 : 0.16,
                opacity: 0.95,
                weight: zone.assigned_to_name || zone.assignments?.length ? 3 : 2,
                dashArray: zone.assigned_to_name || zone.assignments?.length ? undefined : '6,6',
              }}
            >
              <Tooltip permanent direction="center" className="route-number-tooltip">
                <div className="rounded-xl border shadow-xl overflow-hidden text-center min-w-[74px]" style={{ borderColor: zone.color || '#A855F7', background: 'rgba(5,5,8,.9)' }}>
                  <div className="px-2 py-0.5 text-[10px] font-black" style={{ background: zone.color || '#A855F7', color: '#050505' }}>
                    Z{zone.zone_number} · {zone.estimated_doors || '?'} doors
                  </div>
                  <div className="px-2 py-1 text-[10px] font-bold text-white truncate max-w-[130px]">{label}</div>
                </div>
              </Tooltip>
            </Polygon>
            {zone.drop_point && (
              <Marker position={zone.drop_point} icon={dropIcon(zone.color || '#A855F7')}>
                <Tooltip direction="top">
                  Drop point — Zone {zone.zone_number}
                </Tooltip>
              </Marker>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}