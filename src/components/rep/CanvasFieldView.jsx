import React, { useMemo, useState } from 'react';
import { MapContainer, TileLayer, Polygon, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { CheckCircle2, MapPin, Navigation, ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function normalizePoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const lat = Number(point?.lat ?? point?.latitude);
  const lng = Number(point?.lng ?? point?.longitude ?? point?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function normalizeRing(value) {
  if (Array.isArray(value)) return value.map(normalizePoint).filter(Boolean);
  if (value?.type === 'Polygon') return (value.coordinates?.[0] || []).map(normalizePoint).filter(Boolean);
  return [];
}

function zoneParts(zone) {
  if (Array.isArray(zone?.parts) && zone.parts.length) return zone.parts.map(normalizeRing).filter((part) => part.length >= 3);
  if (zone?.geometry?.type === 'MultiPolygon') {
    return (zone.geometry.coordinates || []).map((polygon) => (polygon?.[0] || []).map(normalizePoint).filter(Boolean)).filter((part) => part.length >= 3);
  }
  const geometry = normalizeRing(zone?.geometry);
  return geometry.length >= 3 ? [geometry] : [];
}

function assignmentKey(assignment, index) {
  return `${assignment?.session_id || 'session'}:${assignment?.zone?.zone_id || assignment?.zone?.zone_number || index}`;
}

function normalizeAssignments(assignments) {
  if (!Array.isArray(assignments)) return [];
  return assignments.map((assignment, index) => ({
    ...assignment,
    __key: assignmentKey(assignment, index),
    doors: (Array.isArray(assignment?.doors) ? assignment.doors : []).map((door) => {
      const point = normalizePoint(door);
      const stableDoorId = String(door?.stable_door_id || '').trim();
      return point && stableDoorId ? { ...door, ...point, stable_door_id: stableDoorId } : null;
    }).filter(Boolean),
  })).filter((assignment) => assignment?.zone);
}

function mapCenter(zone, doors) {
  const points = zoneParts(zone).flat();
  const candidates = points.length ? points : doors;
  if (!candidates.length) return [0, 0];
  const center = candidates.reduce((sum, point) => [sum[0] + point.lat / candidates.length, sum[1] + point.lng / candidates.length], [0, 0]);
  return center;
}

function doorColor(door) {
  if (door.status === 'complete' || door.outcome) return '#2EEB57';
  return '#FFD166';
}

function FitAssignmentBounds({ parts, doors }) {
  const map = useMap();
  React.useEffect(() => {
    const points = [...parts.flat(), ...doors].filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
  }, [doors, map, parts]);
  return null;
}

export default function CanvasFieldView({ assignments = [], truncated = false, rejectedDeployments = 0, user, navigationApp = 'google', onClose }) {
  const normalizedAssignments = useMemo(() => normalizeAssignments(assignments), [assignments]);
  const [selectedAssignmentKey, setSelectedAssignmentKey] = useState(() => normalizedAssignments[0]?.__key || '');
  const [selectedDoor, setSelectedDoor] = useState(null);
  const assignment = normalizedAssignments.find((item) => item.__key === selectedAssignmentKey) || normalizedAssignments[0] || null;
  const zone = assignment?.zone || null;
  const doors = assignment?.doors || [];
  const parts = zoneParts(zone);
  const center = mapCenter(zone, doors);
  const zoneColor = zone?.color || '#A855F7';

  React.useEffect(() => {
    if (normalizedAssignments.some((item) => item.__key === selectedAssignmentKey)) return;
    setSelectedAssignmentKey(normalizedAssignments[0]?.__key || '');
    setSelectedDoor(null);
  }, [normalizedAssignments, selectedAssignmentKey]);

  React.useEffect(() => {
    setSelectedDoor(null);
  }, [assignment?.__key, assignment?.version]);

  if (!assignment) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-black p-6 text-center text-white">
        <ShieldAlert className="mb-4 h-10 w-10 text-amber-300" />
        <h1 className="text-xl font-black">Canvas assignment unavailable</h1>
        <p className="mt-2 max-w-sm text-sm text-gray-400">No deployed, server-authorized Canvas area was returned for your team-member ID.</p>
        <Button onClick={onClose} className="mt-6 bg-white/10 text-white">Close</Button>
      </div>
    );
  }

  const openNavigation = () => {
    if (!selectedDoor) return;
    const destination = `${selectedDoor.lat},${selectedDoor.lng}`;
    const url = navigationApp === 'apple'
      ? `https://maps.apple.com/?daddr=${destination}&dirflg=d`
      : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="h-full flex flex-col bg-black text-white">
      <div className="px-4 py-3 border-b border-white/10 bg-black space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black text-[#39FF4A] tracking-widest uppercase">Deployed Canvas Assignment</p>
            <h1 className="text-lg font-black truncate">{assignment.session_name} · Zone {zone.zone_number}</h1>
            <p className="text-xs text-gray-500 truncate">Assigned to {user?.full_name || 'your verified team profile'} · version {assignment.version}</p>
          </div>
          <Button onClick={onClose} size="icon" className="bg-white/10 border border-white/10 text-white"><X className="w-4 h-4" /></Button>
        </div>
        {normalizedAssignments.length > 1 && (
          <Select value={assignment.__key} onValueChange={(value) => { setSelectedAssignmentKey(value); setSelectedDoor(null); }}>
            <SelectTrigger className="h-10 w-full rounded-xl border-white/10 bg-white/5 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[4000] border-white/10 bg-black text-white">
              {normalizedAssignments.map((item) => (
                <SelectItem key={item.__key} value={item.__key}>{item.session_name} · Zone {item.zone.zone_number} · {item.doors.length} homes</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {truncated && <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-2 text-[10px] text-amber-200">The server response reached its door limit. Do not treat this view as complete; ask your manager to reduce the deployment size.</p>}
        {Number(rejectedDeployments) > 0 && <p className="rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-[10px] text-red-200">{rejectedDeployments} deployment{rejectedDeployments === 1 ? '' : 's'} failed the server signature check and were hidden.</p>}
      </div>

      <div className="flex-1 relative">
        <MapContainer key={assignment.__key} center={center} zoom={parts.length || doors.length ? 16 : 2} style={{ height: '100%', width: '100%' }} zoomControl={false} attributionControl={false} preferCanvas>
          <FitAssignmentBounds parts={parts} doors={doors} />
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" attribution="&copy; CARTO" />
          {parts.map((part, index) => (
            <Polygon key={`${assignment.__key}:part:${index}`} positions={part} pathOptions={{ color: zoneColor, fillColor: zoneColor, fillOpacity: 0.18, weight: 3 }}>
              {index === 0 && (
                <Tooltip permanent direction="center" className="route-number-tooltip">
                  <div className="rounded-full bg-black/80 border px-3 py-1 text-xs font-black text-white" style={{ borderColor: zoneColor }}>Zone {zone.zone_number}</div>
                </Tooltip>
              )}
            </Polygon>
          ))}
          {doors.map((door) => (
            <CircleMarker key={door.stable_door_id} center={[door.lat, door.lng]} radius={7} eventHandlers={{ click: () => setSelectedDoor(door) }} pathOptions={{ color: '#050505', fillColor: doorColor(door), fillOpacity: 1, weight: selectedDoor?.stable_door_id === door.stable_door_id ? 4 : 2 }}>
              <Tooltip direction="top">Assigned home · {door.stable_door_id.slice(-8)}</Tooltip>
            </CircleMarker>
          ))}
          {zone.drop_point && normalizePoint(zone.drop_point) && (
            <CircleMarker center={[normalizePoint(zone.drop_point).lat, normalizePoint(zone.drop_point).lng]} radius={9} pathOptions={{ color: '#fff', fillColor: zoneColor, fillOpacity: 1, weight: 2 }}>
              <Tooltip direction="top">Area center</Tooltip>
            </CircleMarker>
          )}
        </MapContainer>

        <div className="absolute top-4 left-4 right-4 z-[1000] flex items-center justify-between gap-2 pointer-events-none">
          <Badge className="pointer-events-auto bg-black/80 border border-white/10 text-white">{doors.length} server-assigned homes</Badge>
          <Badge className="pointer-events-auto bg-black/80 border border-white/10 text-white"><MapPin className="w-3 h-3 mr-1" /> Select a home</Badge>
        </div>

        {!doors.length && (
          <div className="absolute bottom-4 left-4 right-4 z-[1000] rounded-2xl border border-amber-400/20 bg-black/90 p-4 text-sm text-amber-200">
            This assignment has no valid stable-door coordinates. Arbitrary map taps are disabled so work cannot be logged against the wrong home.
          </div>
        )}
      </div>

      {selectedDoor && (
        <div className="fixed inset-x-0 bottom-0 z-[1200] rounded-t-3xl bg-[#09090f] border-t border-white/10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-black">Assigned home</p>
              <p className="text-[11px] text-gray-500">Stable door ID · {selectedDoor.stable_door_id}</p>
            </div>
            <button onClick={() => setSelectedDoor(null)} className="p-2 rounded-full bg-white/10"><X className="w-4 h-4" /></button>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-2">
            <Button onClick={openNavigation} className="h-12 bg-[#2EEB57] text-black hover:bg-[#39FF4A]"><Navigation className="w-4 h-4" /> Navigate to home</Button>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-gray-400">
              <CheckCircle2 className="h-4 w-4 text-amber-300" /> Outcome logging will activate only when the server sync endpoint is available; no local-only result will be recorded.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
