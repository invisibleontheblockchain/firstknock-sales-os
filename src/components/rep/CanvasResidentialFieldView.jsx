import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Polygon, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { CheckCircle2, Loader2, LocateFixed, MapPin, Navigation, RefreshCw, ShieldAlert, WifiOff, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import CanvasBaseMapTiles from '@/components/canvas/CanvasBaseMapTiles';
import MapAttributionControl from '@/components/map/MapAttributionControl';
import { createCanvasOfflineStore } from '@/components/canvas/canvasOfflineStore';
import {
  canvasChangesToOfflineDelta,
  loadCanvasOfflineAssignments,
} from '@/components/canvas/canvasOfflinePackageRuntime';
import { getCanvasPackageTrustConfig } from '@/components/canvas/canvasPackageTrust';
import { isCanvasDncProtected } from '@/components/canvas/canvasDncSafety';
import { isCanvasFieldTapSafe } from '@/components/canvas/canvasFieldSafety';
import { createCanvasSyncEngine } from '@/components/canvas/canvasSyncEngine';
import {
  getCanvasAssignmentArtifact,
  getCanvasAssignmentPackage,
  getCanvasChanges,
  syncCanvasDecisionBatch,
} from '@/components/canvas/canvasProductionClient';
import {
  CANVAS_OUTCOMES,
  canvasZoneStreetSegments,
  getCanvasOutcome,
  normalizeCanvasPin,
  normalizeCanvasRing,
} from '@/components/canvas/canvasOutcomeUtils';

const RECOVERY_SYNC_MS = 5 * 60_000;
const MAX_FIELD_VIEWPORT_MARKERS = 1_500;

function makeIdempotencyKey() {
  try { return crypto.randomUUID(); } catch { return `canvas_decision_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function indexKey(assignment, index = 0) {
  return `${assignment?.campaign_id || assignment?.session_id || 'campaign'}:${assignment?.zone?.zone_id || assignment?.zone_id || index}`;
}

function assignmentCenter(streetSegments, geometry, pins) {
  const points = streetSegments.flatMap((segment) => [segment.start, segment.end]);
  const candidates = points.length ? points : geometry.length ? geometry : pins;
  const valid = candidates.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
  if (!valid.length) return [33.4484, -112.074];
  return valid.reduce((result, point) => [result[0] + point.lat / valid.length, result[1] + point.lng / valid.length], [0, 0]);
}

function FitTerritory({ points }) {
  const map = useMap();
  useEffect(() => {
    const valid = points.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
    if (!valid.length) return;
    const bounds = L.latLngBounds(valid.map((point) => [point.lat, point.lng]));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 18 });
  }, [map, points]);
  return null;
}

function MapTap({ disabled, onTap }) {
  useMapEvents({ click: (event) => { if (!disabled) onTap({ lat: event.latlng.lat, lng: event.latlng.lng }); } });
  return null;
}

function LocateControl() {
  const map = useMap();
  return <Button type="button" aria-label="Center map on my location" onClick={() => map.locate({ setView: true, maxZoom: 19, enableHighAccuracy: true })} size="icon" className="absolute right-4 top-4 z-[1000] h-11 w-11 rounded-full border border-white/20 bg-black/85 text-white shadow-xl"><LocateFixed className="h-5 w-5" /></Button>;
}

function ViewportDecisionMarkers({ pins, pendingPins, dncPins, dncEntries, onEdit, onStatus }) {
  const map = useMap();
  const [viewportRevision, setViewportRevision] = useState(0);
  useEffect(() => {
    const update = () => setViewportRevision((value) => value + 1);
    map.on('moveend zoomend', update);
    update();
    return () => map.off('moveend zoomend', update);
  }, [map]);

  const windowed = useMemo(() => {
    const bounds = map.getBounds();
    const visible = (items) => items.filter((item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng)
      && bounds.contains([item.lat, item.lng]));
    const visibleDnc = visible(dncPins);
    const visiblePins = visible(pins);
    const visiblePending = visible(pendingPins);
    const prioritized = [
      ...visibleDnc.map((pin) => ({ kind: 'dnc', pin })),
      ...visiblePins.filter((pin) => isCanvasDncProtected(pin, dncEntries)).map((pin) => ({ kind: 'pin', pin })),
      ...visiblePending.filter((pin) => isCanvasDncProtected(pin, dncEntries)).map((pin) => ({ kind: 'pending', pin })),
      ...visiblePending.filter((pin) => !isCanvasDncProtected(pin, dncEntries)).map((pin) => ({ kind: 'pending', pin })),
      ...visiblePins.filter((pin) => !isCanvasDncProtected(pin, dncEntries)).map((pin) => ({ kind: 'pin', pin })),
    ];
    const selected = prioritized.slice(0, MAX_FIELD_VIEWPORT_MARKERS);
    return {
      pins: selected.filter((entry) => entry.kind === 'pin').map((entry) => entry.pin),
      pending: selected.filter((entry) => entry.kind === 'pending').map((entry) => entry.pin),
      dnc: selected.filter((entry) => entry.kind === 'dnc').map((entry) => entry.pin),
      total: prioritized.length,
      truncated: prioritized.length > selected.length,
    };
  }, [dncEntries, dncPins, map, pendingPins, pins, viewportRevision]);

  useEffect(() => {
    onStatus?.({ total: windowed.total, rendered: windowed.pins.length + windowed.pending.length + windowed.dnc.length, truncated: windowed.truncated });
  }, [onStatus, windowed.dnc.length, windowed.pending.length, windowed.pins.length, windowed.total, windowed.truncated]);

  return <>
    {windowed.pins.map((pin, index) => { const protectedDnc = isCanvasDncProtected(pin, dncEntries); const outcome = getCanvasOutcome(protectedDnc ? 'do_not_knock' : pin.latest_outcome); return <CircleMarker key={pin.pin_id || `pin:${pin.lat}:${pin.lng}:${index}`} center={[pin.lat, pin.lng]} radius={protectedDnc ? 10 : 8} bubblingMouseEvents={false} eventHandlers={{ click: () => onEdit(pin) }} pathOptions={{ color: protectedDnc ? '#F87171' : '#fff', fillColor: protectedDnc ? '#111827' : outcome.color, fillOpacity: 1, weight: protectedDnc ? 3 : 2 }}><Tooltip>{protectedDnc ? 'Team do not knock · protected' : outcome.label}{pin.address ? ` · ${pin.address}` : ''}</Tooltip></CircleMarker>; })}
    {windowed.pending.map((pin, index) => { const protectedDnc = isCanvasDncProtected(pin, dncEntries); const outcome = getCanvasOutcome(pin.latest_outcome); return <CircleMarker key={pin.pin_id || `pending:${pin.lat}:${pin.lng}:${index}`} center={[pin.lat, pin.lng]} radius={10} bubblingMouseEvents={false} eventHandlers={{ click: () => onEdit(pin) }} pathOptions={{ color: protectedDnc || pin.needs_attention ? '#F87171' : '#FDE68A', fillColor: protectedDnc ? '#111827' : outcome.color, fillOpacity: 0.75, weight: 3, dashArray: '4 3' }}><Tooltip>{protectedDnc ? 'Team do not knock · protected' : pin.needs_attention ? 'Needs review' : 'Pending sync'}{!protectedDnc ? ` · ${outcome.label}` : ''}</Tooltip></CircleMarker>; })}
    {windowed.dnc.map((pin, index) => <CircleMarker key={pin.pin_id || `dnc:${pin.lat}:${pin.lng}:${index}`} center={[pin.lat, pin.lng]} radius={11} bubblingMouseEvents={false} eventHandlers={{ click: () => onEdit(pin) }} pathOptions={{ color: '#F87171', fillColor: '#111827', fillOpacity: 1, weight: 4 }}><Tooltip>Team do not knock · protected</Tooltip></CircleMarker>)}
  </>;
}

function dncAsPin(entry) {
  const point = entry?.point || {};
  return normalizeCanvasPin({
    pin_id: `dnc:${entry?.suppression_id || entry?.id || entry?.house_key}`,
    house_key: entry?.house_key,
    lat: point.lat,
    lng: point.lng,
    latest_outcome: 'do_not_knock',
    dnc_active: true,
    read_only_dnc: true,
  });
}

function pendingAsPin(record) {
  return normalizeCanvasPin({
    pin_id: `pending:${record.idempotencyKey}`,
    ...(record.payload || {}),
    lat: record.payload?.point?.lat,
    lng: record.payload?.point?.lng,
    latest_outcome: record.payload?.outcome,
    latest_note: record.payload?.note,
    pending: true,
    needs_attention: record.state === 'rejected',
    outbox_record: record,
  });
}

export default function CanvasResidentialFieldView({
  assignments = [],
  user,
  navigationApp = 'google',
  rejectedDeployments = 0,
  onClose,
}) {
  const actorUserId = String(user?.id || '');
  const store = useMemo(() => createCanvasOfflineStore(), []);
  const assignmentIdentity = useMemo(() => assignments.map((assignment, index) => [
    indexKey(assignment, index),
    Number(assignment?.version || 0),
    Number(assignment?.assignment_version || 0),
    String(assignment?.package_id || ''),
    String(assignment?.package_version || ''),
    String(assignment?.manifest_hash || ''),
  ].join(':')).sort().join('|'), [assignments]);
  const stableAssignmentsRef = useRef({ identity: null, assignments: [] });
  if (stableAssignmentsRef.current.identity !== assignmentIdentity) {
    stableAssignmentsRef.current = { identity: assignmentIdentity, assignments };
  }
  const stableAssignments = stableAssignmentsRef.current.assignments;
  const packageTrust = useMemo(() => {
    try { return { value: getCanvasPackageTrustConfig(), error: null }; }
    catch (error) { return { value: null, error }; }
  }, []);
  const [loadedByKey, setLoadedByKey] = useState(new Map());
  const [loadErrors, setLoadErrors] = useState(new Map());
  const [selectedKey, setSelectedKey] = useState(() => indexKey(assignments[0], 0));
  const [loadingPackages, setLoadingPackages] = useState(true);
  const [pins, setPins] = useState([]);
  const [dncEntries, setDncEntries] = useState([]);
  const [outbox, setOutbox] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);
  const [pinDraft, setPinDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [markerWindow, setMarkerWindow] = useState({ total: 0, rendered: 0, truncated: false });
  const activeLoadRef = useRef(0);
  const syncRunRef = useRef(null);

  const loadPackages = useCallback(async ({ quiet = false } = {}) => {
    if (!actorUserId) return;
    const requestId = activeLoadRef.current + 1;
    activeLoadRef.current = requestId;
    if (!quiet) setLoadingPackages(true);
    const results = await loadCanvasOfflineAssignments({
      indexAssignments: stableAssignments,
      actorUserId,
      store,
      trustedSigningKey: packageTrust.value,
      concurrency: 3,
      fetchPackage: ({ assignmentId, campaignId, zoneId, packageVersion }) => getCanvasAssignmentPackage({ assignmentId, campaignId, zoneId, packageVersion }),
      fetchArtifact: ({ assignmentId, campaignId, zoneId, packageVersion, artifactId }) => getCanvasAssignmentArtifact({ assignmentId, campaignId, zoneId, packageVersion, artifactId }),
    });
    if (activeLoadRef.current !== requestId) return;
    const nextLoaded = new Map();
    const nextErrors = new Map();
    for (const result of results) {
      const key = indexKey(stableAssignments[result.index], result.index);
      if (result.loaded) nextLoaded.set(key, result.loaded);
      else nextErrors.set(key, packageTrust.error || result.error);
    }
    setLoadedByKey(nextLoaded);
    setLoadErrors(nextErrors);
    const firstKey = nextLoaded.keys().next().value || '';
    setSelectedKey((current) => nextLoaded.has(current) ? current : firstKey);
    setOffline([...nextLoaded.values()].some((entry) => entry.offline));
    if (!quiet) setLoadingPackages(false);
  }, [actorUserId, packageTrust, stableAssignments, store]);

  useEffect(() => {
    loadPackages();
    return () => { activeLoadRef.current += 1; };
  }, [loadPackages]);

  const loaded = loadedByKey.get(selectedKey) || null;
  const assignment = loaded?.assignment || null;
  const zone = assignment?.zone || null;
  const scope = useMemo(() => assignment ? ({
    actorUserId,
    campaignId: assignment.campaign_id,
    zoneId: zone.zone_id,
    packageVersion: String(assignment.package_version),
  }) : null, [actorUserId, assignment?.campaign_id, assignment?.package_version, zone?.zone_id]);
  const syncEngine = useMemo(() => !scope ? null : createCanvasSyncEngine({
    store,
    transport: ({ items }) => syncCanvasDecisionBatch({
      assignmentId: assignment.assignment_id,
      packageVersion: assignment.package_version,
      items,
    }),
  }), [assignment?.assignment_id, assignment?.package_version, scope?.campaignId, scope?.zoneId, store]);

  const refreshLocalState = useCallback(async () => {
    if (!scope) return;
    const [nextPins, dnc, pending] = await Promise.all([
      store.getPins(scope),
      store.getDncSnapshot(scope),
      store.listOutbox({
        ...scope,
        states: ['pending', 'retry', 'rejected'],
        includeAllPackageVersions: true,
        dueBefore: Date.now() + 365 * 24 * 60 * 60_000,
        limit: 1_000,
      }),
    ]);
    setPins(nextPins.map(normalizeCanvasPin).filter(Boolean));
    setDncEntries(dnc?.entries || []);
    setOutbox(pending);
  }, [scope, store]);

  const pullChanges = useCallback(async () => {
    if (!scope || !assignment?.assignment_id || typeof navigator !== 'undefined' && navigator.onLine === false) return;
    for (let page = 0; page < 20; page += 1) {
      const cursor = await store.getCursor(scope);
      const response = await getCanvasChanges({
        assignmentId: assignment.assignment_id,
        packageVersion: assignment.package_version,
        sinceCursor: cursor || 0,
        limit: 500,
      });
      await store.applySyncResult({
        ...scope,
        expectedCursor: cursor,
        outcomes: [],
        delta: canvasChangesToOfflineDelta(response.changes || []),
        nextCursor: response.next_cursor,
      });
      if (!response.has_more) break;
      if (page === 19) throw new Error('Canvas has more map changes than this device could safely apply at once. Sync again.');
    }
  }, [assignment?.assignment_id, assignment?.package_version, scope, store]);

  const syncNow = useCallback(({ quiet = false } = {}) => {
    if (!scope || !syncEngine || typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.resolve({ ok: false, offline: true, rejected: 0, retried: 0, issues: [] });
    }
    const runKey = `${scope.campaignId}:${scope.zoneId}:${scope.packageVersion}`;
    if (syncRunRef.current?.key === runKey) return syncRunRef.current.promise;
    const previous = syncRunRef.current?.promise;
    const operation = (async () => {
      if (previous) await previous.catch(() => null);
      setSyncing(true);
      try {
        const result = await syncEngine.flushAvailable({ ...scope, maxBatches: 20 });
        if (!result.offline) await pullChanges();
        await refreshLocalState();
        setOffline(result.offline === true);
        if (!quiet && !result.ok) {
          const firstIssue = result.issues?.[0]?.error?.message || result.error?.message;
          toast.error(firstIssue || (result.rejected
            ? `${result.rejected} Canvas decision${result.rejected === 1 ? '' : 's'} need review and remain on this device.`
            : 'Canvas could not finish syncing. Pending decisions remain on this device.'));
        }
        return result;
      } catch (error) {
        setOffline(true);
        if (!quiet) toast.error(`${error?.message || 'Canvas could not sync.'} Your pending decisions remain on this device.`);
        await refreshLocalState().catch(() => null);
        return { ok: false, offline: true, rejected: 0, retried: 0, issues: [], error };
      } finally {
        if (syncRunRef.current?.promise === operation) syncRunRef.current = null;
        setSyncing(false);
      }
    })();
    syncRunRef.current = { key: runKey, promise: operation };
    return operation;
  }, [pullChanges, refreshLocalState, scope, syncEngine]);

  useEffect(() => {
    setPinDraft(null);
    refreshLocalState().then(() => syncNow({ quiet: true }));
    const onlineHandler = () => { setOffline(false); syncNow({ quiet: true }); };
    const offlineHandler = () => setOffline(true);
    const focusHandler = () => syncNow({ quiet: true });
    const interval = window.setInterval(() => syncNow({ quiet: true }), RECOVERY_SYNC_MS);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    window.addEventListener('focus', focusHandler);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
      window.removeEventListener('focus', focusHandler);
    };
  }, [refreshLocalState, scope?.campaignId, scope?.zoneId, syncNow]);

  const nextRetryAt = useMemo(() => outbox
    .filter((record) => ['pending', 'retry'].includes(record.state) && record.packageVersion === scope?.packageVersion)
    .map((record) => Date.parse(record.nextAttemptAt || record.queuedAt))
    .filter(Number.isFinite)
    .reduce((earliest, timestamp) => Math.min(earliest, timestamp), Infinity), [outbox, scope?.packageVersion]);

  useEffect(() => {
    if (!Number.isFinite(nextRetryAt) || !scope) return undefined;
    const delay = Math.max(250, Math.min(RECOVERY_SYNC_MS, nextRetryAt - Date.now()));
    const timer = window.setTimeout(() => syncNow({ quiet: true }), delay);
    return () => window.clearTimeout(timer);
  }, [nextRetryAt, scope, syncNow]);

  const streetSegments = useMemo(() => canvasZoneStreetSegments(zone, assignment?.work_units), [assignment?.work_units, zone]);
  const streetPaths = useMemo(() => streetSegments.map((segment) => [segment.start, segment.end]), [streetSegments]);
  const territoryRing = useMemo(() => normalizeCanvasRing(zone?.geometry), [zone?.geometry]);
  const territoryParts = useMemo(() => (Array.isArray(zone?.parts) ? zone.parts.map(normalizeCanvasRing).filter((ring) => ring.length >= 3) : []), [zone?.parts]);
  const fitPoints = useMemo(() => streetSegments.flatMap((segment) => [segment.start, segment.end]), [streetSegments]);
  const center = useMemo(() => assignmentCenter(streetSegments, territoryRing, pins), [pins, streetSegments, territoryRing]);
  const dncPins = useMemo(() => dncEntries.map(dncAsPin).filter(Boolean), [dncEntries]);
  const pendingPins = useMemo(() => outbox.map(pendingAsPin).filter(Boolean), [outbox]);

  if (loadingPackages) return <div className="flex h-screen items-center justify-center bg-black text-white"><div className="text-center"><Loader2 className="mx-auto h-10 w-10 animate-spin text-purple-400" /><p className="mt-3 text-sm text-gray-400">Verifying your offline Canvas maps…</p></div></div>;
  if (!assignment) return <div className="flex h-screen flex-col items-center justify-center bg-black p-6 text-center text-white"><ShieldAlert className="h-11 w-11 text-red-300" /><h1 className="mt-4 text-xl font-black">Canvas field work is locked</h1><p className="mt-2 max-w-sm text-sm text-gray-400">No complete, current, signed assignment package could be verified. {loadErrors.values().next().value?.message || 'Ask your manager to publish the offline rep maps, then retry.'}</p><Button onClick={() => loadPackages()} className="mt-5 bg-purple-600 text-white"><RefreshCw className="h-4 w-4" /> Retry package</Button><Button onClick={onClose} className="mt-2 bg-white/10 text-white">Close</Button></div>;

  const chooseLocation = (point) => {
    if (!isCanvasFieldTapSafe(point, streetSegments)) {
      return toast.error('Tap a house near one of your assigned streets. This location is too far from your territory to save safely.');
    }
    if (isCanvasDncProtected({ point }, dncEntries)) {
      return toast.error('This house is on the team do-not-knock list. It cannot receive another field outcome.');
    }
    setPinDraft({
      point,
      outcome: '',
      note: '',
      address: '',
      unitLabel: '',
      pinId: null,
      houseKey: null,
      idempotencyKey: makeIdempotencyKey(),
    });
  };
  const editPin = (pin) => {
    if (isCanvasDncProtected(pin, dncEntries)) return toast.error('This address is on the team do-not-knock list and cannot be edited from the field map.');
    if (pin.pending) {
      const record = pin.outbox_record;
      return setPinDraft({
        ...(record.payload || {}),
        point: record.payload?.point,
        outcome: record.payload?.outcome || '',
        note: record.payload?.note || '',
        address: record.payload?.address || '',
        unitLabel: record.payload?.unit_label || '',
        pinId: record.payload?.pin_id || null,
        houseKey: record.payload?.house_key || null,
        idempotencyKey: record.idempotencyKey,
        outboxRecord: record,
      });
    }
    setPinDraft({
      point: { lat: pin.lat, lng: pin.lng },
      outcome: pin.latest_outcome || '',
      note: pin.latest_note || '',
      address: pin.address || '',
      unitLabel: pin.unit_label || '',
      pinId: pin.pin_id || null,
      houseKey: pin.house_key || null,
      idempotencyKey: makeIdempotencyKey(),
    });
  };

  const saveDecision = async () => {
    if (!scope || !syncEngine || !pinDraft?.outcome) return toast.error('Choose what happened at this house.');
    if (!isCanvasFieldTapSafe(pinDraft.point, streetSegments)) {
      return toast.error('This house is too far from your current assigned streets. Choose a location inside the territory.');
    }
    if (pinDraft.outcome !== 'do_not_knock' && isCanvasDncProtected(pinDraft, dncEntries)) {
      return toast.error('This house is on the team do-not-knock list. Ordinary outcomes are blocked.');
    }
    setSaving(true);
    const toastId = toast.loading('Saving this decision on your device...');
    try {
      const replacingRejected = pinDraft.outboxRecord?.state === 'rejected';
      if (replacingRejected) await store.discardOutbox({ ...scope, idempotencyKey: pinDraft.outboxRecord.idempotencyKey });
      const idempotencyKey = replacingRejected ? makeIdempotencyKey() : pinDraft.idempotencyKey;
      await syncEngine.queue({
        ...scope,
        idempotencyKey,
        payload: {
          client_recorded_at: new Date().toISOString(),
          point: pinDraft.point,
          outcome: pinDraft.outcome,
          note: String(pinDraft.note || '').trim() || null,
          address: String(pinDraft.address || '').trim() || null,
          unit_label: String(pinDraft.unitLabel || '').trim() || null,
          ...(pinDraft.pinId ? { pin_id: pinDraft.pinId } : {}),
          ...(pinDraft.houseKey ? { house_key: pinDraft.houseKey } : {}),
        },
      });
      setPinDraft(null);
      await refreshLocalState();
      const syncResult = await syncNow({ quiet: true });
      if (syncResult.rejected > 0) {
        const reason = syncResult.issues?.[0]?.error?.message || 'The server rejected this decision.';
        toast.error(`${reason} The original decision is preserved for review.`, { id: toastId });
      } else {
        toast.success(syncResult.ok
          ? 'Decision synced to the shared manager map.'
          : 'Decision saved offline and will retry automatically.', { id: toastId });
      }
    } catch (error) {
      toast.error(error?.message || 'This decision could not be saved safely.', { id: toastId });
    } finally {
      setSaving(false);
    }
  };

  const discardPending = async () => {
    const record = pinDraft?.outboxRecord;
    if (!record || !window.confirm('Discard this unsynced decision from this device?')) return;
    await store.discardOutbox({ ...scope, idempotencyKey: record.idempotencyKey });
    setPinDraft(null);
    await refreshLocalState();
  };

  const openNavigation = () => {
    if (!pinDraft?.point) return;
    const destination = `${pinDraft.point.lat},${pinDraft.point.lng}`;
    const url = navigationApp === 'apple'
      ? `https://maps.apple.com/?daddr=${destination}&dirflg=w`
      : `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const packageOptions = [...loadedByKey.entries()];
  const pendingCount = outbox.filter((record) => record.state !== 'rejected').length;
  const rejectedCount = outbox.filter((record) => record.state === 'rejected').length;
  const firstRejectedReason = outbox.find((record) => record.state === 'rejected')?.lastError?.message || '';
  const zoneColor = zone.color || '#A855F7';

  return <div className="flex h-full flex-col bg-black text-white">
    <header className="space-y-2 border-b border-white/10 bg-black px-4 py-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-widest text-[#39FF4A]">Verified offline Canvas territory</p><h1 className="truncate text-lg font-black">{assignment.session_name || 'Canvas Campaign'} · {zone.name || (zone.zone_number ? `Area ${zone.zone_number}` : 'Assigned area')}</h1><p className="truncate text-xs text-gray-500">{user?.full_name || 'Verified rep'} · tap a house as you work</p></div><Button onClick={onClose} size="icon" className="border border-white/10 bg-white/10 text-white"><X className="h-4 w-4" /></Button></div>
      {packageOptions.length > 1 && <Select value={selectedKey} onValueChange={(value) => setSelectedKey(value)}><SelectTrigger className="h-10 border-white/10 bg-white/5 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{packageOptions.map(([key, value]) => <SelectItem key={key} value={key}>{value.assignment.session_name || 'Canvas Campaign'} · {value.assignment.zone.name || (value.assignment.zone.zone_number ? `Area ${value.assignment.zone.zone_number}` : 'Assigned area')}</SelectItem>)}</SelectContent></Select>}
      <div className="flex flex-wrap items-center gap-2 text-[10px]"><span className={`rounded-full border px-2 py-1 ${offline ? 'border-amber-300/30 bg-amber-500/10 text-amber-200' : 'border-green-300/30 bg-green-500/10 text-green-200'}`}>{offline ? <WifiOff className="mr-1 inline h-3 w-3" /> : <CheckCircle2 className="mr-1 inline h-3 w-3" />}{offline ? 'Working offline' : 'Package verified'}</span><span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-gray-300">{pendingCount} pending</span>{rejectedCount > 0 && <span className="rounded-full border border-red-300/30 bg-red-500/10 px-2 py-1 text-red-200">{rejectedCount} needs review</span>}<Button disabled={syncing || offline} onClick={() => syncNow()} size="sm" className="ml-auto h-7 bg-white/10 px-2 text-white">{syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Sync</Button></div>
      {loadErrors.size > 0 && <p className="rounded-lg border border-amber-300/20 bg-amber-500/10 p-2 text-[10px] text-amber-100">{loadErrors.size} other assignment package{loadErrors.size === 1 ? '' : 's'} could not be verified and remain hidden.</p>}{firstRejectedReason && <p className="rounded-lg border border-red-300/20 bg-red-500/10 p-2 text-[10px] text-red-100">Needs review · {firstRejectedReason} Tap the red dashed house marker to replace or discard the preserved decision.</p>}{Number(rejectedDeployments) > 0 && <p className="rounded-lg border border-red-300/20 bg-red-500/10 p-2 text-[10px] text-red-100">{rejectedDeployments} invalid deployment{rejectedDeployments === 1 ? '' : 's'} failed verification and were hidden.</p>}
    </header>
    <main className="relative min-h-0 flex-1"><MapContainer key={selectedKey} center={center} zoom={15} style={{ height: '100%', width: '100%' }} zoomControl={false} attributionControl preferCanvas><CanvasBaseMapTiles /><MapAttributionControl position="bottomleft" /><FitTerritory points={fitPoints.length ? fitPoints : territoryRing} /><MapTap disabled={Boolean(pinDraft)} onTap={chooseLocation} /><LocateControl />{territoryRing.length >= 3 && <Polygon positions={territoryRing} interactive={false} pathOptions={{ color: '#fff', fillOpacity: 0.03, weight: 2, dashArray: '7 7' }} />}{territoryParts.map((ring, index) => <Polygon key={index} positions={ring} interactive={false} pathOptions={{ color: '#fff', fillOpacity: 0.03, weight: 2, dashArray: '7 7' }} />)}{streetPaths.length > 0 && <Polyline positions={streetPaths} interactive={false} pathOptions={{ color: '#050505', opacity: 0.95, weight: 10, lineCap: 'round' }} />}{streetPaths.length > 0 && <Polyline positions={streetPaths} interactive={false} pathOptions={{ color: zoneColor, opacity: 0.98, weight: 6, lineCap: 'round' }}><Tooltip sticky>Your exclusive street territory</Tooltip></Polyline>}<ViewportDecisionMarkers pins={pins} pendingPins={pendingPins} dncPins={dncPins} dncEntries={dncEntries} onEdit={editPin} onStatus={setMarkerWindow} />{pinDraft?.point && <CircleMarker center={[pinDraft.point.lat, pinDraft.point.lng]} radius={11} pathOptions={{ color: '#fff', fillColor: getCanvasOutcome(pinDraft.outcome).color, fillOpacity: 0.9, weight: 3 }} />}</MapContainer>
      {!streetPaths.length && <div className="pointer-events-none absolute inset-x-4 top-4 z-[1100] rounded-xl border border-red-300/30 bg-black/90 p-3 text-xs text-red-100"><ShieldAlert className="mr-2 inline h-4 w-4" />Verified street geometry is missing. Field work is locked; refresh the package.</div>}
      {markerWindow.truncated && <div className="pointer-events-none absolute inset-x-4 top-4 z-[1100] rounded-xl border border-amber-300/30 bg-black/90 p-3 text-xs text-amber-100"><ShieldAlert className="mr-2 inline h-4 w-4" />This view contains {markerWindow.total.toLocaleString()} house and do-not-knock markers. Zoom in to show every protected address; rendering is safely limited to {markerWindow.rendered.toLocaleString()} markers at once.</div>}
      {pinDraft && <section className="absolute inset-x-3 bottom-3 z-[1200] max-h-[72%] overflow-y-auto rounded-2xl border border-white/15 bg-[#0b0b11]/[0.98] p-4 shadow-2xl"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase text-purple-300">House decision</p><p className="text-xs text-gray-400">Saved locally first, then synced to the shared map.</p></div><Button onClick={() => setPinDraft(null)} size="icon" className="h-8 w-8 bg-white/10 text-white"><X className="h-4 w-4" /></Button></div>{pinDraft.outboxRecord?.lastError?.message && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 p-2 text-[10px] leading-relaxed text-red-100">{pinDraft.outboxRecord.lastError.message} The original decision is preserved until you replace or discard it.</p>}<div className="mt-3 grid grid-cols-2 gap-2">{CANVAS_OUTCOMES.map((outcome) => <button type="button" key={outcome.value} onClick={() => setPinDraft((current) => ({ ...current, outcome: outcome.value }))} className={`rounded-xl border p-2.5 text-left text-xs font-bold ${pinDraft.outcome === outcome.value ? 'border-purple-300 bg-purple-500/20 text-white' : 'border-white/10 bg-white/[0.03] text-gray-300'}`}><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: outcome.color }} />{outcome.label}</button>)}</div><div className="mt-3 grid grid-cols-2 gap-2"><Input value={pinDraft.address || ''} onChange={(event) => setPinDraft((current) => ({ ...current, address: event.target.value }))} placeholder="Address · optional" className="border-white/10 bg-black/30 text-white" /><Input value={pinDraft.unitLabel || ''} onChange={(event) => setPinDraft((current) => ({ ...current, unitLabel: event.target.value }))} placeholder="Unit · optional" className="border-white/10 bg-black/30 text-white" /></div><Textarea value={pinDraft.note || ''} onChange={(event) => setPinDraft((current) => ({ ...current, note: event.target.value }))} maxLength={2000} placeholder="Note · optional" className="mt-2 border-white/10 bg-black/30 text-white" /><div className="mt-3 flex gap-2"><Button onClick={openNavigation} className="h-11 border border-white/10 bg-white/10 text-white"><Navigation className="h-4 w-4" /></Button>{pinDraft.outboxRecord && <Button onClick={discardPending} className="h-11 border border-red-300/20 bg-red-500/10 text-red-100">Discard</Button>}<Button disabled={saving || !pinDraft.outcome || !streetPaths.length} onClick={saveDecision} className="h-11 flex-1 bg-purple-600 font-black text-white">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />} {pinDraft.outboxRecord?.state === 'rejected' ? 'Replace & sync' : 'Save decision'}</Button></div></section>}
    </main>
  </div>;
}
