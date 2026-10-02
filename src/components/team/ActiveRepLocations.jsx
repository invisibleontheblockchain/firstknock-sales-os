import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, CircleMarker, Circle, Tooltip, Popup, useMap } from 'react-leaflet';
import { LocateFixed, MapPin, RefreshCw, Radio } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { base44 } from '@/api/base44Client';
import BaseMapTiles from '@/components/map/BaseMapTiles';
import { locationStatus, locationAgeLabel } from '../../../base44/shared/repLocations';

const COLORS = ['#FFD700', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#2dd4bf'];
const markerColor = (rep, index) => /^#[\da-f]{6}$/i.test(rep.color || '') ? rep.color : COLORS[index % COLORS.length];

function MapFocus({ reps, selectedId, fitVersion }) {
  const map = useMap();
  const fitted = useRef(false);
  const previousFit = useRef(fitVersion);
  useEffect(() => {
    map.invalidateSize();
    const selected = reps.find(rep => rep.member_id === selectedId);
    if (selected) {
      map.setView([selected.location.lat, selected.location.lng], Math.max(map.getZoom(), 16));
      return;
    }
    if (!reps.length) return;
    if (!fitted.current || previousFit.current !== fitVersion) {
      map.fitBounds(reps.map(rep => [rep.location.lat, rep.location.lng]), { padding: [55, 55], maxZoom: 16 });
      fitted.current = true;
      previousFit.current = fitVersion;
    }
  }, [map, reps, selectedId, fitVersion]);
  return null;
}

export default function ActiveRepLocations({ managerId, activeTeamCode = 'all' }) {
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState(null);
  const [fitVersion, setFitVersion] = useState(0);
  const [showStale, setShowStale] = useState(true);
  useEffect(() => {
    setSelectedId(null);
    setFitVersion(value => value + 1);
  }, [managerId, activeTeamCode]);
  const { data, dataUpdatedAt, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['repLocations', managerId],
    queryFn: async () => {
      const response = await base44.functions.invoke('repLocations', { action: 'report' });
      if (!response.data?.success || response.data.manager_id !== managerId) throw new Error('Unable to verify rep locations.');
      return response.data;
    },
    enabled: !!managerId, refetchInterval: 10_000, refetchIntervalInBackground: false, retry: 1,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  // Compare GPS timestamps with server time even if the manager's clock differs.
  const serverOffset = data?.server_time ? Date.parse(data.server_time) - dataUpdatedAt : 0;
  const reps = useMemo(() => (data?.reps || [])
    .filter(rep => activeTeamCode === 'all' || rep.invite_code === activeTeamCode)
    .map((rep, index) => ({ ...rep, status: locationStatus(rep.location, now + serverOffset), markerColor: markerColor(rep, index) }))
    .sort((a, b) => ({ live: 0, stale: 1, offline: 2 }[a.status] - { live: 0, stale: 1, offline: 2 }[b.status]) || a.name.localeCompare(b.name)),
  [data, activeTeamCode, now, serverOffset]);
  const visibleReps = useMemo(() => reps.filter(rep => rep.status === 'live' || (showStale && rep.status === 'stale')), [reps, showStale]);
  const liveCount = reps.filter(rep => rep.status === 'live').length;
  const staleCount = reps.filter(rep => rep.status === 'stale').length;

  return (
    <section className="space-y-4 rounded-2xl border border-gray-800 bg-[#111] p-3 text-white md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold"><Radio className="h-5 w-5 text-green-400" />Active Rep Locations</h2>
          <p className="mt-1 text-xs text-gray-400">{liveCount} live · {staleCount} signal delayed · {reps.length - liveCount - staleCount} offline</p>
          <p className="mt-1 text-xs text-gray-500">Refreshes every 10 seconds. Reps share location from their app while in the field.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setSelectedId(null); setFitVersion(value => value + 1); }}
            className="flex min-h-10 items-center gap-1.5 rounded-lg border border-gray-700 px-3 text-xs hover:bg-white/5"><LocateFixed className="h-4 w-4" />Fit all reps</button>
          <button type="button" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh rep locations"
            className="flex min-h-10 items-center rounded-lg border border-gray-700 px-3 hover:bg-white/5 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
        {error?.response?.data?.error || error.message || 'Unable to refresh rep locations.'} Use refresh to retry. Displayed locations may be out of date.
      </p>}
      <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={showStale} onChange={event => setShowStale(event.target.checked)} />Show last known locations for delayed signals</label>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="relative isolate h-[380px] overflow-hidden rounded-xl border border-gray-800 md:h-[520px]">
          <MapContainer center={[39.5, -98.35]} zoom={4} className="h-full w-full" attributionControl zoomControl>
            <BaseMapTiles mapTheme="dark" />
            <MapFocus reps={visibleReps} selectedId={selectedId} fitVersion={fitVersion} />
            {visibleReps.map(rep => (
              <React.Fragment key={rep.member_id}>
                <Circle center={[rep.location.lat, rep.location.lng]} radius={Math.min(rep.location.accuracy || 0, 2000)}
                  pathOptions={{ color: rep.markerColor, weight: 1, fillOpacity: 0.06, opacity: rep.status === 'live' ? 0.5 : 0.2 }} />
                <CircleMarker center={[rep.location.lat, rep.location.lng]} radius={selectedId === rep.member_id ? 11 : 8}
                  pathOptions={{ color: '#fff', weight: 2, fillColor: rep.markerColor, fillOpacity: rep.status === 'live' ? 1 : 0.35, dashArray: rep.status === 'stale' ? '3 3' : undefined }}
                  eventHandlers={{ click: () => setSelectedId(rep.member_id) }}>
                  <Tooltip permanent direction="top">{rep.name}{rep.status === 'stale' ? ' · delayed' : ''}</Tooltip>
                  <Popup><strong>{rep.name}</strong><br />{rep.status === 'live' ? 'Live' : 'Last known location'} · {locationAgeLabel(rep.location, now + serverOffset)}<br />GPS accuracy: ±{Math.round(rep.location.accuracy || 0)}m</Popup>
                </CircleMarker>
              </React.Fragment>
            ))}
          </MapContainer>
          {!visibleReps.length && <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center bg-black/45 p-6 text-center">
            <div className="max-w-sm rounded-xl border border-gray-700 bg-[#111]/95 p-5">
              <MapPin className="mx-auto mb-2 h-7 w-7 text-yellow-500" />
              <p className="font-bold">{isPending ? 'Loading rep locations…' : error && !data ? 'Rep locations unavailable' : 'No active locations yet'}</p>
              <p className="mt-2 text-xs text-gray-400">Reps appear here after tapping Share location and allowing GPS access. Keep the app open for live updates.</p>
            </div>
          </div>}
        </div>
        <div className="max-h-[520px] space-y-2 overflow-y-auto">
          {reps.map(rep => <button type="button" key={rep.member_id}
            disabled={rep.status === 'offline' || (rep.status === 'stale' && !showStale)}
            aria-pressed={selectedId === rep.member_id} onClick={() => setSelectedId(rep.member_id)}
            className={`w-full rounded-xl border p-3 text-left transition ${selectedId === rep.member_id ? 'border-yellow-500 bg-yellow-500/10' : 'border-gray-800 bg-black/30'} disabled:cursor-default`}>
            <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{rep.name}</span>
              <span className={`shrink-0 text-[10px] font-bold ${rep.status === 'live' ? 'text-green-400' : rep.status === 'stale' ? 'text-amber-400' : 'text-gray-500'}`}>{rep.status === 'stale' ? 'DELAYED' : rep.status.toUpperCase()}</span></div>
            <p className="mt-1 text-xs text-gray-400">{rep.location ? `${locationAgeLabel(rep.location, now + serverOffset)} · ±${Math.round(rep.location.accuracy || 0)}m` : 'Location sharing off or signal unavailable'}</p>
            {selectedId === rep.member_id && <p className="mt-1 text-[10px] text-yellow-400">Following this rep on the map</p>}
          </button>)}
          {!isPending && !error && !reps.length && <p className="p-3 text-xs text-gray-500">No active reps in this team. Add reps from the Roster tab.</p>}
        </div>
      </div>
      <p className="text-[11px] text-gray-500">A signal becomes delayed after 1 minute and leaves the map after 5 minutes. Closing the app, losing GPS, or going offline can interrupt updates.</p>
    </section>
  );
}
