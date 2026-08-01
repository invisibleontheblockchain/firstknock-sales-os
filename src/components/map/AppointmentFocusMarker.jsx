import React, { useMemo } from 'react';
import { Marker, Tooltip } from 'react-leaflet';
import L from 'leaflet';

/**
 * Standalone pin for an appointment opened from the Appointments tab.
 *
 * The appointment's route is often not loaded on the map, so without this the
 * door only existed while its detail card was open — closing the card left
 * nothing to click. This marker persists so the pin stays selectable.
 */
export default function AppointmentFocusMarker({ property, onSelect }) {
  const lat = Number(property?.lat);
  const lng = Number(property?.lng);
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001);

  const icon = useMemo(() => L.divIcon({
    className: '',
    html: '<div style="width:18px;height:18px;border-radius:50%;background:#FFFFFF;border:3px solid #000;box-shadow:0 0 14px rgba(255,255,255,0.8)"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  }), []);

  if (!valid) return null;

  return (
    <Marker
      position={[lat, lng]}
      icon={icon}
      zIndexOffset={1200}
      eventHandlers={{ click: () => onSelect?.(property) }}
    >
      <Tooltip direction="top" offset={[0, -12]}>
        {property.full_address || property.address || 'Selected door'}
      </Tooltip>
    </Marker>
  );
}