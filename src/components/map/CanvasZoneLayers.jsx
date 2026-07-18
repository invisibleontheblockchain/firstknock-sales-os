import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LayerGroup, Marker, Polyline, Tooltip } from 'react-leaflet';
import { canvasZoneStreetSegments, formatCanvasDistance } from '@/components/canvas/canvasOutcomeUtils';

const UNASSIGNED_COLOR = '#A855F7';
const ASSIGNED_COLOR = '#64748B';
const HOVER_DELAY_MS = 180;

function hasAssignment(zone) {
  return Boolean(zone.assigned_team_member_id || zone.assigned_to_name || zone.assignments?.filter(Boolean).length);
}

function getRepInitials(label) {
  if (!label || label === 'Unassigned') return '';
  return label.split('+')[0].trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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
    html: `<div style="width:22px;height:22px;border-radius:999px;background:#111827;color:#E5E7EB;border:2px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;box-shadow:0 8px 18px rgba(0,0,0,.35)">${escapeHtml(initials)}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function labelIcon(zone, label, color) {
  const zoneNumber = Number.isFinite(Number(zone.zone_number)) ? Number(zone.zone_number) : '?';
  const workload = formatCanvasDistance(zone.street_length_meters).replace(' of streets', '');
  return L.divIcon({
    className: 'canvas-zone-label',
    html: `<div style="border:1px solid ${color};background:rgba(5,5,8,.94);border-radius:12px;overflow:hidden;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.35);min-width:88px"><div style="background:${color};color:white;font-size:10px;font-weight:900;padding:2px 8px">Area ${zoneNumber} &middot; ${escapeHtml(workload)}</div><div style="color:white;font-size:10px;font-weight:700;padding:4px 8px;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(label)}</div></div>`,
    iconSize: [90, 38],
    iconAnchor: [45, 19],
  });
}

export default function CanvasZoneLayers({ zones = [], workUnits = [] }) {
  const [selectedZoneNumber, setSelectedZoneNumber] = useState(null);
  const [hoveredZoneNumber, setHoveredZoneNumber] = useState(null);
  const [filteredZoneNumbers, setFilteredZoneNumbers] = useState([]);
  const hoverTimerRef = useRef(null);

  useEffect(() => {
    const handleSelected = (event) => setSelectedZoneNumber(event.detail?.zoneNumber || null);
    const handleFiltered = (event) => setFilteredZoneNumbers(Array.isArray(event.detail?.zoneNumbers) ? event.detail.zoneNumbers : []);
    window.addEventListener('fk-canvas-zone-selected', handleSelected);
    window.addEventListener('fk-canvas-zone-filtered', handleFiltered);
    return () => {
      window.removeEventListener('fk-canvas-zone-selected', handleSelected);
      window.removeEventListener('fk-canvas-zone-filtered', handleFiltered);
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  return (
    <LayerGroup>
      {zones.map((zone) => {
        const segments = canvasZoneStreetSegments(zone, workUnits);
        if (!segments.length) return null;
        const label = zone.assigned_to_name
          || (zone.assigned_team_member_id ? `Assigned rep · ${String(zone.assigned_team_member_id).slice(-6)}` : '')
          || zone.assignments?.filter(Boolean).join(' + ')
          || 'Unassigned';
        const assigned = hasAssignment(zone);
        const color = zone.color || (assigned ? ASSIGNED_COLOR : UNASSIGNED_COLOR);
        const selected = selectedZoneNumber === zone.zone_number;
        const hovered = hoveredZoneNumber === zone.zone_number;
        const shouldShowLabel = selected || hovered || filteredZoneNumbers.includes(zone.zone_number);
        const initials = getRepInitials(label);
        const labelPoint = zone.drop_point || zone.center;
        const paths = segments.map((segment) => [segment.start, segment.end]);
        const handleClick = () => window.dispatchEvent(new CustomEvent('fk-canvas-zone-selected', { detail: { zoneNumber: zone.zone_number } }));
        return (
          <LayerGroup key={`canvas-zone-${zone.zone_number}`}>
            <Polyline
              positions={paths}
              interactive={false}
              pathOptions={{ color: selected ? '#FFFFFF' : '#050505', opacity: 0.95, weight: selected ? 11 : hovered ? 10 : 8, lineCap: 'round', lineJoin: 'round' }}
            />
            <Polyline
              positions={paths}
              bubblingMouseEvents={false}
              pathOptions={{ color, opacity: 0.96, weight: selected ? 7 : hovered ? 6 : 5, lineCap: 'round', lineJoin: 'round' }}
              eventHandlers={{
                click: handleClick,
                mouseover: () => {
                  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                  hoverTimerRef.current = setTimeout(() => setHoveredZoneNumber(zone.zone_number), HOVER_DELAY_MS);
                },
                mouseout: () => {
                  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                  setHoveredZoneNumber((current) => current === zone.zone_number ? null : current);
                },
              }}
            >
              <Tooltip sticky>Area {zone.zone_number} · {label} · colored streets define ownership</Tooltip>
            </Polyline>
            {assigned && initials && labelPoint && <Marker position={labelPoint} icon={avatarIcon(initials)} interactive={false} keyboard={false} />}
            {shouldShowLabel && labelPoint && <Marker position={labelPoint} icon={labelIcon(zone, label, color)} interactive={false} keyboard={false} />}
            {zone.drop_point && (
              <Marker position={zone.drop_point} icon={dropIcon(color)}>
                <Tooltip direction="top">Area {zone.zone_number} street territory center</Tooltip>
              </Marker>
            )}
          </LayerGroup>
        );
      })}
    </LayerGroup>
  );
}
