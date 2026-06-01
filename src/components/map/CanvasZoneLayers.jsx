import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LayerGroup, Marker, Polygon, Tooltip } from 'react-leaflet';
import CanvasBoundaryHandles from './CanvasBoundaryHandles';

const UNASSIGNED_COLOR = '#A855F7';
const ASSIGNED_COLOR = '#64748B';
const HOVER_DELAY_MS = 300;

function hasAssignment(zone) {
  return Boolean(zone.assigned_to_name || zone.assignments?.filter(Boolean).length);
}

function getRepInitials(label) {
  if (!label || label === 'Unassigned') return '';
  return label.split('+')[0].trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function dropIcon(color) {
  return L.divIcon({
    className: 'canvas-drop-icon',
    html: `<div style="width:16px;height:16px;border-radius:999px;background:${color};border:3px solid #ffffff;box-shadow:0 0 0 2px #050505,0 8px 18px rgba(0,0,0,.35)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function avatarIcon(initials) {
  return L.divIcon({
    className: 'canvas-zone-avatar',
    html: `<div style="width:22px;height:22px;border-radius:999px;background:#111827;color:#E5E7EB;border:2px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;box-shadow:0 8px 18px rgba(0,0,0,.35)">${initials}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function labelIcon(zone, label, color) {
  return L.divIcon({
    className: 'canvas-zone-label',
    html: `<div style="border:1px solid ${color};background:rgba(5,5,8,.94);border-radius:12px;overflow:hidden;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.35);min-width:76px"><div style="background:${color};color:white;font-size:10px;font-weight:900;padding:2px 8px">Z${zone.zone_number} · ${zone.estimated_doors || '?'} doors</div><div style="color:white;font-size:10px;font-weight:700;padding:4px 8px;max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div></div>`,
    iconSize: [90, 38],
    iconAnchor: [45, 19],
  });
}

export default function CanvasZoneLayers({ zones = [] }) {
  const [selectedZoneNumber, setSelectedZoneNumber] = useState(null);
  const [editZoneNumber, setEditZoneNumber] = useState(null);
  const [hoveredZoneNumber, setHoveredZoneNumber] = useState(null);
  const [filteredZoneNumbers, setFilteredZoneNumbers] = useState([]);
  const [focusMode, setFocusMode] = useState(() => {
    try { return localStorage.getItem('fk_canvasFocusMode') === 'true'; } catch { return false; }
  });
  const hoverTimerRef = useRef(null);

  useEffect(() => {
    const handleSelected = (event) => setSelectedZoneNumber(event.detail?.zoneNumber || null);
    const handleEdit = (event) => setEditZoneNumber(event.detail?.zoneNumber || null);
    const handleFiltered = (event) => setFilteredZoneNumbers(Array.isArray(event.detail?.zoneNumbers) ? event.detail.zoneNumbers : []);
    const handleFocus = (event) => setFocusMode(Boolean(event.detail?.focusMode));
    window.addEventListener('fk-canvas-zone-selected', handleSelected);
    window.addEventListener('fk-canvas-zone-edit-changed', handleEdit);
    window.addEventListener('fk-canvas-zone-filtered', handleFiltered);
    window.addEventListener('fk-canvas-focus-mode-changed', handleFocus);
    return () => {
      window.removeEventListener('fk-canvas-zone-selected', handleSelected);
      window.removeEventListener('fk-canvas-zone-edit-changed', handleEdit);
      window.removeEventListener('fk-canvas-zone-filtered', handleFiltered);
      window.removeEventListener('fk-canvas-focus-mode-changed', handleFocus);
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  return (
    <LayerGroup>
      {zones.filter((zone) => (zone.parts || [zone.geometry]).some((part) => part?.length > 2)).map((zone) => {
        const label = zone.assigned_to_name || zone.assignments?.filter(Boolean).join(' + ') || 'Unassigned';
        const parts = zone.parts?.length ? zone.parts : [zone.geometry];
        const assigned = hasAssignment(zone);
        const color = assigned ? ASSIGNED_COLOR : UNASSIGNED_COLOR;
        const shouldShowLabel = !focusMode && (selectedZoneNumber === zone.zone_number || hoveredZoneNumber === zone.zone_number || filteredZoneNumbers.includes(zone.zone_number));
        const initials = getRepInitials(label);
        return (
          <LayerGroup key={`canvas-zone-${zone.zone_number}`}>
            {parts.filter((part) => part?.length > 2).map((part, partIndex) => (
              <Polygon
                key={`canvas-zone-${zone.zone_number}-${partIndex}`}
                positions={part}
                pathOptions={{
                  color: selectedZoneNumber === zone.zone_number && !focusMode ? '#FFFFFF' : '#050505',
                  fillColor: color,
                  fillOpacity: assigned ? 0.26 : 0.36,
                  opacity: focusMode ? 0.55 : 0.85,
                  weight: selectedZoneNumber === zone.zone_number && !focusMode ? 3 : 1,
                }}
                eventHandlers={{
                  click: () => window.dispatchEvent(new CustomEvent('fk-canvas-zone-selected', { detail: { zoneNumber: zone.zone_number } })),
                  mouseover: () => {
                    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                    hoverTimerRef.current = setTimeout(() => setHoveredZoneNumber(zone.zone_number), HOVER_DELAY_MS);
                  },
                  mouseout: () => {
                    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                    setHoveredZoneNumber((current) => current === zone.zone_number ? null : current);
                  },
                }}
              />
            ))}
            {!focusMode && assigned && initials && zone.center && <Marker position={zone.center} icon={avatarIcon(initials)} interactive={false} keyboard={false} />}
            {shouldShowLabel && zone.center && <Marker position={zone.center} icon={labelIcon(zone, label, color)} interactive={false} keyboard={false} />}
            {!focusMode && zone.drop_point && (
              <Marker position={zone.drop_point} icon={dropIcon(color)}>
                <Tooltip direction="top">
                  Drop point — Zone {zone.zone_number}
                </Tooltip>
              </Marker>
            )}
          </LayerGroup>
        );
      })}
      <CanvasBoundaryHandles zones={zones} editZoneNumber={focusMode ? null : editZoneNumber} />
    </LayerGroup>
  );
}