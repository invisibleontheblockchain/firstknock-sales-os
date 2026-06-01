import React, { useMemo, useState } from 'react';
import { MapContainer, TileLayer, Polygon, CircleMarker, Tooltip, useMapEvents } from 'react-leaflet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { X, MapPin, CheckCircle2 } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

const OUTCOMES = [
  { status: 'SOLD', label: 'Sold', color: '#00F5A0' },
  { status: 'CALLBACK', label: 'Callback', color: '#FFD93D' },
  { status: 'NO_ANSWER', label: 'No Answer', color: '#E5E7EB' },
  { status: 'HARD_NO', label: 'Not Interested', color: '#FF6B6B' },
  { status: 'DO_NOT_KNOCK', label: 'Do Not Knock', color: '#DC2626' },
  { status: 'VACANT', label: 'Vacant', color: '#94A3B8' },
  { status: 'NO_ACCESS', label: 'Gated / No Access', color: '#A855F7' },
];

function TapCapture({ onTap }) {
  useMapEvents({
    click(event) {
      onTap({ lat: event.latlng.lat, lng: event.latlng.lng });
    }
  });
  return null;
}

function zoneCenter(zone) {
  const points = zone?.geometry || [];
  if (!points.length) return [34.513, -82.699];
  const center = points.reduce((sum, point) => [sum[0] + point.lat / points.length, sum[1] + point.lng / points.length], [0, 0]);
  return center;
}

function logKey(campaign, zone) {
  return `fk_canvasDoorLogs_${(campaign?.name || 'campaign').replace(/\W+/g, '_')}_${zone?.zone_number || 1}`;
}

export default function CanvasFieldView({ campaign, zone, user, onClose }) {
  const [pendingPoint, setPendingPoint] = useState(null);
  const [logs, setLogs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(logKey(campaign, zone)) || '[]'); } catch { return []; }
  });

  const center = useMemo(() => zoneCenter(zone), [zone]);
  const assignedLabel = zone?.assignments?.filter(Boolean).join(' + ') || zone?.assigned_to_name || user?.full_name || 'Canvas rep';

  const saveOutcome = (outcome) => {
    if (!pendingPoint) return;
    const next = [...logs, {
      id: `canvas_${Date.now()}`,
      ...pendingPoint,
      status: outcome.status,
      label: outcome.label,
      color: outcome.color,
      rep_name: user?.full_name || assignedLabel,
      created_date: new Date().toISOString(),
      zone_number: zone.zone_number,
      campaign_name: campaign.name,
    }];
    setLogs(next);
    localStorage.setItem(logKey(campaign, zone), JSON.stringify(next));
    setPendingPoint(null);
  };

  return (
    <div className="h-full flex flex-col bg-black text-white">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-black">
        <div className="min-w-0">
          <p className="text-[10px] font-black text-purple-300 tracking-widest uppercase">Canvas Field View</p>
          <h1 className="text-lg font-black truncate">Zone {zone.zone_number} — {logs.length} doors knocked</h1>
          <p className="text-xs text-gray-500 truncate">{assignedLabel}</p>
        </div>
        <Button onClick={onClose} size="icon" className="bg-white/10 border border-white/10 text-white"><X className="w-4 h-4" /></Button>
      </div>

      <div className="flex-1 relative">
        <MapContainer center={center} zoom={16} style={{ height: '100%', width: '100%' }} zoomControl={false} attributionControl={false} preferCanvas>
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" attribution="&copy; CARTO" />
          <TapCapture onTap={setPendingPoint} />
          <Polygon positions={zone.geometry || []} pathOptions={{ color: zone.color, fillColor: zone.color, fillOpacity: 0.18, weight: 3 }}>
            <Tooltip permanent direction="center" className="route-number-tooltip">
              <div className="rounded-full bg-black/80 border px-3 py-1 text-xs font-black text-white" style={{ borderColor: zone.color }}>Zone {zone.zone_number}</div>
            </Tooltip>
          </Polygon>
          {zone.drop_point && (
            <CircleMarker center={[zone.drop_point.lat, zone.drop_point.lng]} radius={8} pathOptions={{ color: '#050505', fillColor: zone.color, fillOpacity: 1, weight: 3 }}>
              <Tooltip direction="top">Van drop point</Tooltip>
            </CircleMarker>
          )}
          {logs.map((log) => (
            <CircleMarker key={log.id} center={[log.lat, log.lng]} radius={7} pathOptions={{ color: '#050505', fillColor: log.color, fillOpacity: 1, weight: 2 }}>
              <Tooltip direction="top">{log.label}</Tooltip>
            </CircleMarker>
          ))}
          {pendingPoint && <CircleMarker center={[pendingPoint.lat, pendingPoint.lng]} radius={9} pathOptions={{ color: '#fff', fillColor: '#FFD93D', fillOpacity: 1, weight: 2 }} />}
        </MapContainer>

        <div className="absolute top-4 left-4 right-4 z-[1000] flex items-center justify-between gap-2 pointer-events-none">
          <Badge className="pointer-events-auto bg-black/80 border border-white/10 text-white">~{zone.estimated_doors} target doors</Badge>
          <Badge className="pointer-events-auto bg-black/80 border border-white/10 text-white"><MapPin className="w-3 h-3 mr-1" /> Tap map to log</Badge>
        </div>
      </div>

      {pendingPoint && (
        <div className="fixed inset-x-0 bottom-0 z-[1200] rounded-t-3xl bg-[#09090f] border-t border-white/10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-black">Log this door</p>
              <p className="text-[11px] text-gray-500">One tap saves the outcome locally.</p>
            </div>
            <button onClick={() => setPendingPoint(null)} className="p-2 rounded-full bg-white/10"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {OUTCOMES.map((outcome) => (
              <button key={outcome.status} onClick={() => saveOutcome(outcome)} className="h-12 rounded-xl font-black text-sm flex items-center justify-center gap-2" style={{ background: `${outcome.color}22`, color: outcome.color, border: `1px solid ${outcome.color}55` }}>
                <CheckCircle2 className="w-4 h-4" /> {outcome.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}