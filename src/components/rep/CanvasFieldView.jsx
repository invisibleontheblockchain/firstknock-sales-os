import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Polygon, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { CheckCircle2, Layers, Loader2, LocateFixed, MapPin, Navigation, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getCanvasCampaignMap, logCanvasHouseDecision } from '@/components/canvas/canvasProductionClient';
import { getFieldRoutesStatuses } from '@/api/fieldRoutes';
import ScheduleInspectionAction from '@/components/fieldroutes/ScheduleInspectionAction';
import CanvasBaseMapTiles from '@/components/canvas/CanvasBaseMapTiles';
import MapAttributionControl from '@/components/map/MapAttributionControl';
import {
  fieldRoutesStatusRows,
  fieldRoutesStatusPresentation,
  findFieldRoutesStatus,
  isFieldRoutesCapabilityReady,
  isFieldRoutesTerminalStatus,
  preferFieldRoutesStatus,
} from '@/components/fieldroutes/fieldRoutesPresentation';
import {
  acknowledgeCanvasDecision,
  listQueuedCanvasDecisions,
  queueCanvasDecision,
} from '@/components/canvas/canvasDecisionQueue';
import {
  CANVAS_OUTCOMES,
  canvasZoneStreetSegments,
  getCanvasOutcome,
  normalizeCanvasPin,
  normalizeCanvasPoint,
  normalizeCanvasRing,
} from '@/components/canvas/canvasOutcomeUtils';

function fieldRoutesOverlayStyle(status) {
  const tone = status?.tone;
  if (tone === 'synced') return { color: '#38BDF8', label: 'FieldRoutes sent' };
  if (tone === 'attention') return { color: '#FB7185', label: 'FieldRoutes needs review' };
  if (tone === 'device') return { color: '#FBBF24', label: 'FieldRoutes saved on device', dashArray: '3 3' };
  if (tone === 'pending') return { color: '#F59E0B', label: 'FieldRoutes sync pending', dashArray: '4 3' };
  return null;
}

// Legacy campaigns retain a recovery refresh. Residential v2 uses package and
// cursor sync; neither path should redownload a full campaign every 15 seconds.
const PIN_REFRESH_MS = 5 * 60_000;
const FIELDROUTES_STATUS_POLL_MS = 15_000;
const DNC_SAFETY_ERROR_CODES = new Set(['dnc_safety_limit_exceeded', 'dnc_safety_integrity_failed']);

function canvasFieldRoutesStatus(response, sourceKey, pinId = '') {
  return findFieldRoutesStatus(response, (row) => (
    String(row?.source_key || row?.source_reference || '') === sourceKey
    || pinId && String(row?.pin_id || '') === String(pinId)
  ));
}

function shouldPollCanvasFieldRoutes(response, localStatuses, campaignId, zoneId) {
  const sourcePrefix = campaignId && zoneId ? `canvas:${campaignId}:${zoneId}:` : '';
  const serverRows = fieldRoutesStatusRows(response).filter((row) => (
    (!campaignId || String(row?.campaign_id || '') === String(campaignId))
    && (!zoneId || String(row?.zone_id || '') === String(zoneId))
  ));
  if (serverRows.some((row) => !isFieldRoutesTerminalStatus(row))) return true;
  return Object.entries(localStatuses || {}).some(([sourceKey, localStatus]) => {
    if (!sourcePrefix || !sourceKey.startsWith(sourcePrefix)) return false;
    const serverStatus = canvasFieldRoutesStatus(response, sourceKey);
    return !isFieldRoutesTerminalStatus(preferFieldRoutesStatus(localStatus, serverStatus));
  });
}

function makeIdempotencyKey() {
  try { return crypto.randomUUID(); } catch { return `canvas_pin_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function assignmentKey(assignment, index) {
  return `${assignment?.campaign_id || assignment?.session_id || 'campaign'}:${assignment?.zone?.zone_id || assignment?.zone?.zone_number || index}`;
}

function normalizeAssignments(assignments) {
  if (!Array.isArray(assignments)) return [];
  return assignments.map((assignment, index) => ({
    ...assignment,
    campaign_id: String(assignment?.campaign_id || assignment?.session_id || ''),
    __key: assignmentKey(assignment, index),
  })).filter((assignment) => assignment.campaign_id && assignment?.zone);
}

function mapCenter(mapPoints, pins) {
  const points = mapPoints.length ? mapPoints : pins;
  const validPoints = points.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && (p.lat !== 0 || p.lng !== 0));
  if (!validPoints.length) return [34.0522, -118.2437];
  return validPoints.reduce(
    (sum, point) => [sum[0] + point.lat / validPoints.length, sum[1] + point.lng / validPoints.length],
    [0, 0]
  );
}

function FitAssignmentBounds({ mapPoints, pins }) {
  const map = useMap();
  useEffect(() => {
    const points = [...mapPoints, ...pins].filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 18 });
  }, [map, mapPoints, pins]);
  return null;
}

function MapTapCapture({ onPinLocation }) {
  useMapEvents({
    click(event) {
      onPinLocation({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
    contextmenu(event) {
      onPinLocation({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

function LocateControl() {
  const map = useMap();
  return (
    <Button
      type="button"
      aria-label="Center map on my location"
      onClick={() => map.locate({ setView: true, maxZoom: 19, enableHighAccuracy: true })}
      size="icon"
      className="absolute right-4 top-20 z-[1000] h-11 w-11 rounded-full border border-white/20 bg-black/85 text-white shadow-xl hover:bg-black"
    >
      <LocateFixed className="h-5 w-5" />
    </Button>
  );
}

function mergePin(current, nextPin) {
  const normalized = normalizeCanvasPin(nextPin);
  if (!normalized) return current;
  const index = current.findIndex((pin) => pin.pin_id && pin.pin_id === normalized.pin_id);
  if (index < 0) return [...current, normalized];
  return current.map((pin, pinIndex) => pinIndex === index ? normalized : pin);
}

function terminalDecisionError(error) {
  const code = String(error?.code || '').toLowerCase();
  if (code.includes('write_in_progress') || code === 'pin_version_conflict') return false;
  const status = Number(error?.status);
  if (['idempotency_key_reused', 'canvas_pin_outside_owned_street', 'canvas_pin_zone_ambiguous'].includes(code)) return true;
  return Number.isFinite(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function decisionErrorMessage(error) {
  return String(error?.message || 'This pending decision needs review before it can sync.');
}

function isDncSafetyFailure(error) {
  return DNC_SAFETY_ERROR_CODES.has(String(error?.code || '').toLowerCase());
}

function dncSafetyFailureMessage(error) {
  if (String(error?.code || '').toLowerCase() === 'dnc_safety_limit_exceeded') {
    return 'Do-not-knock coverage exceeded this campaign\'s safety limit. House pins are withheld and logging is locked. Stop field work and ask your manager to split or archive the campaign, then retry.';
  }
  return 'Do-not-knock coverage could not be verified. House pins are withheld and logging is locked. Stop field work, ask your manager to review the campaign, then retry.';
}

export default function CanvasFieldView({
  assignments = [],
  truncated = false,
  rejectedDeployments = 0,
  user,
  navigationApp = 'google',
  fieldRoutesCapability,
  fieldRoutesPendingBySource = {},
  fieldRoutesPendingDeviceCount = 0,
  onDiscardFieldRoutesDeviceAttention,
  onScheduleFieldRoutesInspection,
  onClose,
}) {
  const normalizedAssignments = useMemo(() => normalizeAssignments(assignments), [assignments]);
  const [selectedAssignmentKey, setSelectedAssignmentKey] = useState(() => normalizedAssignments[0]?.__key || '');
  const [pins, setPins] = useState([]);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [pinsTruncated, setPinsTruncated] = useState(false);
  const [dncSafetyComplete, setDncSafetyComplete] = useState(false);
  const [dncSafetyIssue, setDncSafetyIssue] = useState('');
  const [pendingDecisions, setPendingDecisions] = useState([]);
  const [pinDraft, setPinDraft] = useState(null);
  const [replacementTemplate, setReplacementTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [satellite, setSatellite] = useState(true);
  const [fieldRoutesStatuses, setFieldRoutesStatuses] = useState(null);
  const [fieldRoutesLocalStatuses, setFieldRoutesLocalStatuses] = useState({});
  const activeRequestRef = useRef(0);
  const dncSafetyCompleteRef = useRef(false);
  const assignment = normalizedAssignments.find((item) => item.__key === selectedAssignmentKey) || normalizedAssignments[0] || null;
  const zone = assignment?.zone || null;
  const actorUserId = String(user?.id || '');
  const assignedTeamMemberId = String(zone?.assigned_team_member_id || assignment?.assigned_team_member_id || '');
  const streetSegments = useMemo(() => canvasZoneStreetSegments(zone, assignment?.work_units), [assignment?.work_units, zone]);
  const campaignBoundary = useMemo(() => normalizeCanvasRing(assignment?.campaign_boundary), [assignment?.campaign_boundary]);
  const streetPaths = useMemo(() => streetSegments.map((segment) => [segment.start, segment.end]), [streetSegments]);
  const mapPoints = useMemo(() => {
    const streetPoints = streetSegments.flatMap((segment) => [segment.start, segment.end]);
    return streetPoints.length ? streetPoints : campaignBoundary;
  }, [campaignBoundary, streetSegments]);
  const center = useMemo(() => mapCenter(mapPoints, pins), [mapPoints, pins]);
  const zoneColor = zone?.color || '#A855F7';
  const fieldRoutesCanvasReady = isFieldRoutesCapabilityReady(fieldRoutesCapability, 'canvas');

  const refreshFieldRoutesStatuses = useCallback(async () => {
    if (!isFieldRoutesCapabilityReady(fieldRoutesCapability, 'canvas')) {
      setFieldRoutesStatuses(null);
      return;
    }
    if (!assignment?.campaign_id || !zone?.zone_id) return;
    try {
      const result = await getFieldRoutesStatuses({
        source_mode: 'canvas',
        campaign_id: assignment.campaign_id,
        zone_id: zone.zone_id,
      });
      setFieldRoutesStatuses(result);
    } catch {
      // FieldRoutes status is supplemental; Canvas safety and house decisions keep their own behavior.
    }
  }, [assignment?.campaign_id, fieldRoutesCapability, zone?.zone_id]);
  const fieldRoutesPollingRequired = useMemo(() => fieldRoutesCanvasReady && shouldPollCanvasFieldRoutes(
    fieldRoutesStatuses,
    fieldRoutesLocalStatuses,
    assignment?.campaign_id,
    zone?.zone_id,
  ), [assignment?.campaign_id, fieldRoutesCanvasReady, fieldRoutesLocalStatuses, fieldRoutesStatuses, zone?.zone_id]);

  useEffect(() => {
    if (normalizedAssignments.some((item) => item.__key === selectedAssignmentKey)) return;
    setSelectedAssignmentKey(normalizedAssignments[0]?.__key || '');
    setPinDraft(null);
  }, [normalizedAssignments, selectedAssignmentKey]);

  const refreshPins = useCallback(async ({ quiet = false } = {}) => {
    if (!assignment?.campaign_id) return false;
    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;
    if (!quiet) setPinsLoading(true);
    try {
      const result = await getCanvasCampaignMap({ campaignId: assignment.campaign_id });
      if (activeRequestRef.current !== requestId) return false;
      if (result.dnc_safety?.complete !== true) {
        setPins([]);
        setPinsTruncated(false);
        dncSafetyCompleteRef.current = false;
        setDncSafetyComplete(false);
        setDncSafetyIssue('Do-not-knock coverage was not confirmed by the server. House pins are withheld and logging is locked. Retry before field work.');
        setPinDraft(null);
        setReplacementTemplate(null);
        return false;
      }
      const zoneId = String(zone?.zone_id || '');
      const visiblePins = result.pins
        .map(normalizeCanvasPin)
        .filter((pin) => pin && (!zoneId || String(pin.zone_id || '') === zoneId));
      setPins(visiblePins);
      setPinsTruncated(result.truncated === true || result.truncated?.pins === true);
      dncSafetyCompleteRef.current = true;
      setDncSafetyComplete(true);
      setDncSafetyIssue('');
      return true;
    } catch (error) {
      if (activeRequestRef.current !== requestId) return false;
      if (isDncSafetyFailure(error)) {
        setPins([]);
        setPinsTruncated(false);
        dncSafetyCompleteRef.current = false;
        setDncSafetyComplete(false);
        setDncSafetyIssue(dncSafetyFailureMessage(error));
        setPinDraft(null);
        setReplacementTemplate(null);
      } else if (!dncSafetyCompleteRef.current) {
        setDncSafetyIssue('Do-not-knock coverage has not been verified. Check your connection and retry; house logging remains locked.');
      }
      if (!quiet) toast.error(error.message || 'Canvas house pins could not be loaded.');
      return false;
    } finally {
      if (!quiet && activeRequestRef.current === requestId) setPinsLoading(false);
    }
  }, [assignment?.campaign_id, zone?.zone_id]);

  const refreshPendingDecisions = useCallback(async () => {
    if (!actorUserId || !assignment?.campaign_id || !zone?.zone_id) return;
    const queued = await listQueuedCanvasDecisions({ actorUserId, assignedTeamMemberId, campaignId: assignment.campaign_id, zoneId: zone.zone_id });
    setPendingDecisions(queued);
  }, [actorUserId, assignedTeamMemberId, assignment?.campaign_id, zone?.zone_id]);

  const retryPendingDecisions = useCallback(async ({ safetyVerified = dncSafetyCompleteRef.current } = {}) => {
    if (!safetyVerified || !actorUserId || !assignment?.campaign_id || !zone?.zone_id || typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const queued = await listQueuedCanvasDecisions({ actorUserId, assignedTeamMemberId, campaignId: assignment.campaign_id, zoneId: zone.zone_id });
    for (const decision of queued) {
      if (decision.syncState === 'needs_attention') continue;
      try {
        const result = await logCanvasHouseDecision(decision);
        await acknowledgeCanvasDecision(decision);
        setPins((current) => mergePin(current, result.pin));
      } catch (error) {
        await queueCanvasDecision({
          ...decision,
          syncState: terminalDecisionError(error) ? 'needs_attention' : 'pending',
          lastErrorCode: error?.code || null,
          lastErrorMessage: decisionErrorMessage(error),
        });
        if (!terminalDecisionError(error)) break;
      }
    }
    await refreshPendingDecisions();
  }, [actorUserId, assignedTeamMemberId, assignment?.campaign_id, refreshPendingDecisions, zone?.zone_id]);

  useEffect(() => {
    setPins([]);
    setPinsTruncated(false);
    dncSafetyCompleteRef.current = false;
    setDncSafetyComplete(false);
    setDncSafetyIssue('');
    setPendingDecisions([]);
    setPinDraft(null);
    setReplacementTemplate(null);
    refreshPendingDecisions();
    refreshPins().then((safetyVerified) => {
      if (safetyVerified) retryPendingDecisions({ safetyVerified: true });
    });
    const refresh = async () => {
      const safetyVerified = await refreshPins({ quiet: true });
      if (safetyVerified) retryPendingDecisions({ safetyVerified: true });
    };
    const interval = window.setInterval(refresh, PIN_REFRESH_MS);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
    };
  }, [assignment?.__key, refreshPendingDecisions, refreshPins, retryPendingDecisions]);

  useEffect(() => {
    refreshFieldRoutesStatuses();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshFieldRoutesStatuses();
    };
    window.addEventListener('focus', refreshFieldRoutesStatuses);
    document.addEventListener('visibilitychange', onVisible);
    const interval = fieldRoutesPollingRequired
      ? window.setInterval(refreshFieldRoutesStatuses, FIELDROUTES_STATUS_POLL_MS)
      : null;
    return () => {
      if (interval) window.clearInterval(interval);
      window.removeEventListener('focus', refreshFieldRoutesStatuses);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fieldRoutesPollingRequired, refreshFieldRoutesStatuses]);

  if (!assignment) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-black p-6 text-center text-white">
        <ShieldAlert className="mb-4 h-10 w-10 text-amber-300" />
        <h1 className="text-xl font-black">Canvas assignment unavailable</h1>
        <p className="mt-2 max-w-sm text-sm text-gray-400">No active, server-authorized territory was returned for your team-member ID.</p>
        <Button onClick={onClose} className="mt-6 bg-white/10 text-white">Close</Button>
      </div>
    );
  }

  const choosePinLocation = (point) => {
    if (!dncSafetyComplete) return toast.error('Do-not-knock safety must finish loading before you can log a house.');
    const template = replacementTemplate;
    setPinDraft({
      point,
      outcome: template?.outcome || '',
      note: template?.note || '',
      address: template?.address || '',
      unitLabel: template?.unitLabel || '',
      pinId: null,
      streetUnitId: null,
      idempotencyKey: makeIdempotencyKey(),
      clientRecordedAt: null,
      pendingDecision: null,
    });
    setReplacementTemplate(null);
  };

  const editPin = (pin) => {
    const queuedDecision = pin.queued_decision;
    setPinDraft({
      point: { lat: pin.lat, lng: pin.lng },
      outcome: pin.latest_outcome || '',
      note: pin.latest_note || '',
      address: pin.address || '',
      unitLabel: pin.unit_label || queuedDecision?.unitLabel || '',
      pinId: queuedDecision?.pinId || (pin.pending ? null : pin.pin_id || null),
      streetUnitId: pin.street_unit_id || queuedDecision?.streetUnitId || null,
      idempotencyKey: queuedDecision?.idempotencyKey || makeIdempotencyKey(),
      clientRecordedAt: queuedDecision?.clientRecordedAt || null,
      pendingDecision: queuedDecision || null,
    });
  };

  const saveDecision = async () => {
    if (!dncSafetyComplete) return toast.error('House logging is locked until complete do-not-knock coverage is verified.');
    if (!pinDraft?.outcome) return toast.error('Choose what happened at this house.');
    setSaving(true);
    const toastId = toast.loading('Syncing house decision...');
    const clientRecordedAt = pinDraft.clientRecordedAt || new Date().toISOString();
    setPinDraft((current) => current ? { ...current, clientRecordedAt } : current);
    const decision = {
      actorUserId,
      assignedTeamMemberId,
      campaignId: assignment.campaign_id,
      zoneId: zone.zone_id,
      idempotencyKey: pinDraft.idempotencyKey,
      clientRecordedAt,
      point: pinDraft.point,
      outcome: pinDraft.outcome,
      note: pinDraft.note,
      address: pinDraft.address,
      unitLabel: pinDraft.unitLabel,
      pinId: pinDraft.pinId,
    };
    let safelyQueued = false;
    try {
      await queueCanvasDecision(decision);
      safelyQueued = true;
      await refreshPendingDecisions();
      const result = await logCanvasHouseDecision(decision);
      await acknowledgeCanvasDecision(decision);
      await refreshPendingDecisions();
      setPins((current) => mergePin(current, result.pin));
      setPinDraft(null);
      toast.success(result.idempotent ? 'House decision already synced.' : 'House decision synced to the team map.', { id: toastId });
    } catch (error) {
      const failedDecision = {
        ...decision,
        syncState: terminalDecisionError(error) ? 'needs_attention' : 'pending',
        lastErrorCode: error?.code || null,
        lastErrorMessage: decisionErrorMessage(error),
      };
      if (actorUserId) {
        safelyQueued = await queueCanvasDecision(failedDecision).then(() => true).catch(() => safelyQueued);
        if (safelyQueued) {
          await refreshPendingDecisions().catch(() => null);
          setPinDraft({
            point: decision.point,
            outcome: decision.outcome,
            note: decision.note,
            address: decision.address,
            unitLabel: decision.unitLabel,
            pinId: decision.pinId,
            idempotencyKey: decision.idempotencyKey,
            clientRecordedAt: decision.clientRecordedAt,
            pendingDecision: failedDecision,
          });
        }
      }
      toast.error(safelyQueued
        ? `${error.message || 'House decision could not be synced.'} It is pending on this device and is not shared yet. Retry the exact decision or reconnect.`
        : `${error.message || 'House decision could not be synced.'} This device also could not preserve an offline copy. Keep this sheet open and retry.`, { id: toastId, duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  const retryOnePendingDecision = async (decision) => {
    if (!dncSafetyComplete) return toast.error('Decision sync is locked until complete do-not-knock coverage is verified.');
    if (!decision || saving) return;
    setSaving(true);
    const toastId = toast.loading('Retrying the exact saved decision...');
    try {
      const result = await logCanvasHouseDecision(decision);
      await acknowledgeCanvasDecision(decision);
      await refreshPendingDecisions();
      setPins((current) => mergePin(current, result.pin));
      setPinDraft(null);
      toast.success(result.idempotent ? 'That exact decision was already synced.' : 'House decision synced to the team map.', { id: toastId });
    } catch (error) {
      const needsAttention = terminalDecisionError(error);
      await queueCanvasDecision({
        ...decision,
        syncState: needsAttention ? 'needs_attention' : 'pending',
        lastErrorCode: error?.code || null,
        lastErrorMessage: decisionErrorMessage(error),
      });
      await refreshPendingDecisions();
      setPinDraft((current) => current ? { ...current, pendingDecision: { ...decision, syncState: needsAttention ? 'needs_attention' : 'pending', lastErrorMessage: decisionErrorMessage(error) } } : current);
      toast.error(`${decisionErrorMessage(error)} ${needsAttention ? 'Review, replace, or discard this pending pin.' : 'It remains safely pending on this device.'}`, { id: toastId, duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  const discardPendingDecision = async (decision) => {
    if (!decision || !window.confirm('Discard this unsynced house decision from this device? This cannot be recovered.')) return;
    await acknowledgeCanvasDecision(decision);
    await refreshPendingDecisions();
    setPinDraft(null);
    toast.success('Pending decision discarded from this device.');
  };

  const replacePendingLocation = async (decision) => {
    if (!decision || !window.confirm('Discard this pending location and create a new decision with a new sync key?')) return;
    await acknowledgeCanvasDecision(decision);
    await refreshPendingDecisions();
    setReplacementTemplate(decision);
    setPinDraft(null);
    toast.info('Tap the correct house. The outcome and note will be copied into a new decision.');
  };

  const openNavigation = () => {
    if (!pinDraft?.point) return;
    const destination = `${pinDraft.point.lat},${pinDraft.point.lng}`;
    const url = navigationApp === 'apple'
      ? `https://maps.apple.com/?daddr=${destination}&dirflg=w`
      : `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const fieldRoutesSourceKey = pinDraft?.point && assignment?.campaign_id && zone?.zone_id
    ? `canvas:${assignment.campaign_id}:${zone.zone_id}:${Number(pinDraft.point.lat).toFixed(6)}:${Number(pinDraft.point.lng).toFixed(6)}`
    : '';
  const pinDraftFieldRoutesStatus = fieldRoutesLocalStatuses[fieldRoutesSourceKey]
    || fieldRoutesPendingBySource[fieldRoutesSourceKey];
  const pinDraftServerFieldRoutesStatus = canvasFieldRoutesStatus(
    fieldRoutesStatuses,
    fieldRoutesSourceKey,
    pinDraft?.pinId,
  );
  const preferredPinDraftFieldRoutesStatus = preferFieldRoutesStatus(
    pinDraftFieldRoutesStatus,
    pinDraftServerFieldRoutesStatus,
  );

  const fieldRoutesStyleForPin = (pin) => {
    if (!pin || !assignment?.campaign_id || !zone?.zone_id) return null;
    const sourceKey = `canvas:${assignment.campaign_id}:${zone.zone_id}:${Number(pin.lat).toFixed(6)}:${Number(pin.lng).toFixed(6)}`;
    const localStatus = fieldRoutesLocalStatuses[sourceKey] || fieldRoutesPendingBySource[sourceKey];
    const serverStatus = canvasFieldRoutesStatus(fieldRoutesStatuses, sourceKey, pin?.pin_id);
    const status = preferFieldRoutesStatus(localStatus, serverStatus);
    return status ? fieldRoutesOverlayStyle(fieldRoutesStatusPresentation(status)) : null;
  };

  const scheduleCanvasInspection = async ({ contact, property, notes }) => {
    if (!pinDraft?.point || !pinDraft?.pinId || !assignment?.campaign_id || !zone?.zone_id || !fieldRoutesSourceKey) {
      throw new Error('Sync this Canvas house decision before scheduling an inspection.');
    }
    if (typeof onScheduleFieldRoutesInspection !== 'function') {
      throw new Error('FieldRoutes scheduling is still loading. Try again in a moment.');
    }
    const delivery = await onScheduleFieldRoutesInspection({
      source: {
        kind: 'canvas',
        source_key: fieldRoutesSourceKey,
        campaign_id: assignment.campaign_id,
        zone_id: zone.zone_id,
        pin_id: pinDraft.pinId,
        street_unit_id: pinDraft.streetUnitId || null,
        point: { lat: Number(pinDraft.point.lat), lng: Number(pinDraft.point.lng) },
        unit: property.unit || null,
        address: {
          ...property,
          lat: Number(pinDraft.point.lat),
          lng: Number(pinDraft.point.lng),
        },
      },
      contact,
      property: {
        ...property,
        lat: Number(pinDraft.point.lat),
        lng: Number(pinDraft.point.lng),
      },
      notes,
    });
    setFieldRoutesLocalStatuses((current) => ({ ...current, [fieldRoutesSourceKey]: delivery }));
    setPinDraft((current) => current ? {
      ...current,
      address: property.street_address,
      unitLabel: property.unit || current.unitLabel,
    } : current);
    if (delivery.kind === 'synced') toast.success(delivery.copy);
    else if (delivery.kind === 'attention') toast.error(delivery.copy);
    else if (delivery.kind === 'device_pending') toast.warning(delivery.copy, { duration: 7000 });
    else toast.info(delivery.copy);
    if (delivery.kind !== 'device_pending') refreshFieldRoutesStatuses();
    return delivery;
  };

  const outcomeCounts = pins.reduce((counts, pin) => {
    counts[pin.latest_outcome] = (counts[pin.latest_outcome] || 0) + 1;
    return counts;
  }, {});
  const needsAttentionCount = pendingDecisions.filter((decision) => decision.syncState === 'needs_attention').length;
  const pendingPins = pendingDecisions.map((decision) => normalizeCanvasPin({
    pin_id: `pending:${decision.idempotencyKey}`,
    zone_id: decision.zoneId,
    lat: decision.point?.lat,
    lng: decision.point?.lng,
    latest_outcome: decision.outcome,
    latest_note: decision.note,
    address: decision.address,
    unit_label: decision.unitLabel,
    pending: true,
    needs_attention: decision.syncState === 'needs_attention',
    queued_decision: decision,
  })).filter(Boolean);
  const fieldRoutesOnlyMarkers = (() => {
    const prefix = `canvas:${assignment.campaign_id}:${zone.zone_id}:`;
    const knownPoints = new Set([...pins, ...pendingPins].map((pin) => `${Number(pin.lat).toFixed(6)}:${Number(pin.lng).toFixed(6)}`));
    const bySource = new Map();
    for (const row of fieldRoutesStatusRows(fieldRoutesStatuses)) {
      const sourceKey = String(row?.source_key || row?.source_reference || '');
      if (sourceKey.startsWith(prefix)) bySource.set(sourceKey, row);
    }
    for (const [sourceKey, status] of Object.entries(fieldRoutesPendingBySource || {})) {
      if (sourceKey.startsWith(prefix)) bySource.set(sourceKey, status);
    }
    for (const [sourceKey, status] of Object.entries(fieldRoutesLocalStatuses || {})) {
      if (sourceKey.startsWith(prefix)) bySource.set(sourceKey, status);
    }
    return [...bySource.entries()].map(([sourceKey, status]) => {
      const [latText, lngText] = sourceKey.slice(prefix.length).split(':');
      const lat = Number(latText);
      const lng = Number(lngText);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || knownPoints.has(`${lat.toFixed(6)}:${lng.toFixed(6)}`)) return null;
      return { sourceKey, lat, lng, style: fieldRoutesOverlayStyle(fieldRoutesStatusPresentation(status)) };
    }).filter((marker) => marker?.style);
  })();

  return (
    <div className="h-full flex flex-col bg-black text-white">
      <div className="border-b border-white/10 bg-black px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black text-[#39FF4A] tracking-widest uppercase">Live Canvas Territory</p>
            <h1 className="text-lg font-black truncate">{assignment.session_name} · Area {zone.zone_number}</h1>
            <p className="text-xs text-gray-500 truncate">{user?.full_name || 'Verified rep'} · tap a house as you work</p>
          </div>
          <Button onClick={onClose} size="icon" className="bg-white/10 border border-white/10 text-white"><X className="w-4 h-4" /></Button>
        </div>
        {normalizedAssignments.length > 1 && (
          <Select value={assignment.__key} onValueChange={(value) => { setSelectedAssignmentKey(value); setPinDraft(null); }}>
            <SelectTrigger className="h-10 w-full rounded-xl border-white/10 bg-white/5 text-white"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[4000] border-white/10 bg-black text-white">
              {normalizedAssignments.map((item) => (
                <SelectItem key={item.__key} value={item.__key}>{item.session_name} · Area {item.zone.zone_number}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {truncated && <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-2 text-[10px] text-amber-200">Only part of your active assignment package could be loaded. Refresh before starting work.</p>}
        {!dncSafetyComplete && <div className="rounded-xl border border-red-400/30 bg-red-500/15 p-3 text-red-100"><div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-xs font-black">Field work locked for do-not-knock safety</p><p className="mt-1 text-[10px] leading-relaxed">{dncSafetyIssue || 'Verifying complete do-not-knock coverage before field work. House taps and decision sync stay locked until the safety map loads.'}</p></div></div><Button type="button" disabled={pinsLoading} onClick={() => refreshPins()} className="mt-2 h-9 w-full border border-red-200/20 bg-red-500/20 text-red-50 hover:bg-red-500/30">{pinsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Retry safety check</Button></div>}
        {pinsTruncated && <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-2 text-[10px] text-amber-200">{dncSafetyComplete ? 'Older non-do-not-knock history may be hidden by the map display limit. All do-not-knock pins are still loaded.' : 'Older shared house-pin history may be hidden by the map display limit.'}</p>}
        {Number(rejectedDeployments) > 0 && <p className="rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-[10px] text-red-200">{rejectedDeployments} invalid deployment{rejectedDeployments === 1 ? '' : 's'} failed verification and were hidden.</p>}
      </div>

      <div className="relative flex-1">
        <MapContainer key={assignment.__key} center={center} zoom={15} style={{ height: '100%', width: '100%' }} zoomControl={false} attributionControl preferCanvas>
          <FitAssignmentBounds mapPoints={mapPoints} pins={pins} />
          {dncSafetyComplete && <MapTapCapture onPinLocation={choosePinLocation} />}
          <LocateControl />
          <CanvasBaseMapTiles satellite={satellite} />
          <MapAttributionControl position="bottomleft" />
          {campaignBoundary.length >= 3 && <Polygon positions={campaignBoundary} interactive={false} pathOptions={{ color: '#FFFFFF', fillOpacity: 0, opacity: 0.8, weight: 3, dashArray: '7 7' }}><Tooltip sticky>Global Canvas working area</Tooltip></Polygon>}
          {streetPaths.length > 0 && <Polyline positions={streetPaths} interactive={false} pathOptions={{ color: '#050505', opacity: 0.95, weight: 10, lineCap: 'round', lineJoin: 'round' }} />}
          {streetPaths.length > 0 && <Polyline positions={streetPaths} interactive={false} pathOptions={{ color: zoneColor, opacity: 0.98, weight: 6, lineCap: 'round', lineJoin: 'round' }}><Tooltip sticky>Area {zone.zone_number} · your colored street territory</Tooltip></Polyline>}
          {pins.map((pin, index) => {
            const outcome = getCanvasOutcome(pin.latest_outcome);
            const fieldRoutes = fieldRoutesStyleForPin(pin);
            const markerKey = pin.pin_id || `${pin.lat}:${pin.lng}:${index}`;
            return (
              <React.Fragment key={markerKey}>
                {fieldRoutes && (
                  <CircleMarker
                    center={[pin.lat, pin.lng]}
                    radius={12}
                    interactive={false}
                    pathOptions={{ color: fieldRoutes.color, fillOpacity: 0, weight: 3, dashArray: fieldRoutes.dashArray }}
                  />
                )}
                <CircleMarker
                  center={[pin.lat, pin.lng]}
                  radius={8}
                  bubblingMouseEvents={false}
                  eventHandlers={{ click: () => editPin(pin) }}
                  pathOptions={{ color: '#FFFFFF', fillColor: outcome.color, fillOpacity: 1, weight: 2 }}
                >
                  <Tooltip direction="top">{outcome.label}{pin.address ? ` · ${pin.address}` : ''}{pin.unit_label ? ` · ${pin.unit_label}` : ''}{fieldRoutes ? ` · ${fieldRoutes.label}` : ''}</Tooltip>
                </CircleMarker>
              </React.Fragment>
            );
          })}
          {pendingPins.map((pin) => {
            const outcome = getCanvasOutcome(pin.latest_outcome);
            const fieldRoutes = fieldRoutesStyleForPin(pin);
            return (
              <React.Fragment key={pin.pin_id}>
                {fieldRoutes && (
                  <CircleMarker center={[pin.lat, pin.lng]} radius={14} interactive={false} pathOptions={{ color: fieldRoutes.color, fillOpacity: 0, weight: 3, dashArray: fieldRoutes.dashArray }} />
                )}
                <CircleMarker center={[pin.lat, pin.lng]} radius={10} bubblingMouseEvents={false} eventHandlers={{ click: () => editPin(pin) }} pathOptions={{ color: pin.needs_attention ? '#F87171' : '#FDE68A', fillColor: outcome.color, fillOpacity: 0.75, weight: 3, dashArray: '4 3' }}>
                  <Tooltip direction="top">{pin.needs_attention ? 'Needs review' : 'Pending sync'} · {outcome.label}{pin.unit_label ? ` · ${pin.unit_label}` : ''}{fieldRoutes ? ` · ${fieldRoutes.label}` : ''}</Tooltip>
                </CircleMarker>
              </React.Fragment>
            );
          })}
          {fieldRoutesOnlyMarkers.map((marker) => (
            <CircleMarker
              key={marker.sourceKey}
              center={[marker.lat, marker.lng]}
              radius={9}
              bubblingMouseEvents={false}
              eventHandlers={{ click: () => choosePinLocation({ lat: marker.lat, lng: marker.lng }) }}
              pathOptions={{
                color: marker.style.color,
                fillColor: '#08090B',
                fillOpacity: 0.9,
                weight: 4,
                dashArray: marker.style.dashArray,
              }}
            >
              <Tooltip direction="top">{marker.style.label} · tap to log the Canvas house outcome</Tooltip>
            </CircleMarker>
          ))}
          {zone.drop_point && normalizeCanvasPoint(zone.drop_point) && (
            <CircleMarker center={[normalizeCanvasPoint(zone.drop_point).lat, normalizeCanvasPoint(zone.drop_point).lng]} radius={9} pathOptions={{ color: '#fff', fillColor: zoneColor, fillOpacity: 1, weight: 2 }}>
              <Tooltip direction="top">Area center</Tooltip>
            </CircleMarker>
          )}
        </MapContainer>

        <div className="pointer-events-none absolute left-4 right-4 top-4 z-[1000] flex items-start justify-between gap-2">
          <div className="space-y-2">
            <Badge className="pointer-events-auto border border-white/10 bg-black/85 text-white">{pinsLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <MapPin className="mr-1 h-3 w-3" />}{pins.length} houses logged</Badge>
            {pendingDecisions.length > 0 && <Badge className={`pointer-events-auto ml-1 border ${needsAttentionCount ? 'border-red-300/30 bg-red-500/20 text-red-100' : 'border-amber-300/30 bg-amber-500/20 text-amber-100'}`}>{needsAttentionCount ? `${needsAttentionCount} need review` : `${pendingDecisions.length} pending sync`}</Badge>}
            {Object.keys(outcomeCounts).length > 0 && <div className="pointer-events-auto flex max-w-[70vw] flex-wrap gap-1">{Object.entries(outcomeCounts).map(([outcome, count]) => <Badge key={outcome} className="border border-white/10 bg-black/80 text-[9px] text-white"><span className="mr-1 h-2 w-2 rounded-full" style={{ background: getCanvasOutcome(outcome).color }} />{getCanvasOutcome(outcome).label} {count}</Badge>)}</div>}
          </div>
          <Button type="button" onClick={() => setSatellite((value) => !value)} size="sm" className="pointer-events-auto h-10 border border-white/20 bg-black/85 text-white hover:bg-black"><Layers className="h-4 w-4" /> {satellite ? 'Streets' : 'Satellite'}</Button>
        </div>

        {!pinDraft && dncSafetyComplete && (
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-[1000] rounded-2xl border border-purple-400/30 bg-black/90 p-3 text-center text-sm text-purple-100 shadow-xl">
            <MapPin className="mr-1 inline h-4 w-4" /> {replacementTemplate ? 'Tap the corrected house location to create a new decision.' : 'Colored streets are your territory. Tap the house itself—even when it sits off the line—and the server confirms its nearest owned street.'}
          </div>
        )}
      </div>

      {pinDraft && (
        <div className="fixed inset-x-0 bottom-0 z-[1200] max-h-[86dvh] overflow-y-auto rounded-t-3xl border-t border-white/10 bg-[#09090f] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-black">{pinDraft.pendingDecision ? 'Pending house decision' : pinDraft.pinId ? 'Update house result' : 'Log this house'}</p>
              <p className="text-[11px] text-gray-500">{pinDraft.pendingDecision ? 'The saved payload is locked so its sync key stays safe.' : 'This pin is shared with your manager and team after server acknowledgement.'}</p>
            </div>
            <button disabled={saving} onClick={() => setPinDraft(null)} className="rounded-full bg-white/10 p-2"><X className="h-4 w-4" /></button>
          </div>

          {pinDraft.pendingDecision?.syncState === 'needs_attention' && <p className="mt-3 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-100">{pinDraft.pendingDecision.lastErrorMessage || 'The server rejected this location. Retry the exact decision, choose a replacement location, or discard it.'}</p>}

          <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-white/45">Log outcome</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {CANVAS_OUTCOMES.map((outcome) => (
              <button
                type="button"
                key={outcome.value}
                disabled={saving || !dncSafetyComplete || Boolean(pinDraft.pendingDecision)}
                onClick={() => setPinDraft((current) => ({ ...current, outcome: outcome.value }))}
                className={`flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-bold ${pinDraft.outcome === outcome.value ? 'border-white bg-white/10 text-white' : 'border-white/10 bg-black/30 text-gray-300'}`}
              >
                <span className="h-3 w-3 shrink-0 rounded-full border border-white/40" style={{ background: outcome.color }} />{outcome.label}
              </button>
            ))}
          </div>

          <div className="mt-3 space-y-2">
            <Input disabled={saving || !dncSafetyComplete || Boolean(pinDraft.pendingDecision)} value={pinDraft.address} onChange={(event) => setPinDraft((current) => ({ ...current, address: event.target.value }))} placeholder="Address or house label (optional)" className="h-11 border-white/10 bg-white/5 text-white" />
            <Input disabled={saving || !dncSafetyComplete || Boolean(pinDraft.pendingDecision)} value={pinDraft.unitLabel || ''} onChange={(event) => setPinDraft((current) => ({ ...current, unitLabel: event.target.value }))} placeholder="Unit / apartment (optional)" maxLength={100} className="h-11 border-white/10 bg-white/5 text-white" />
            <Textarea disabled={saving || !dncSafetyComplete || Boolean(pinDraft.pendingDecision)} value={pinDraft.note} onChange={(event) => setPinDraft((current) => ({ ...current, note: event.target.value }))} placeholder="Note or callback detail (optional)" maxLength={1000} className="min-h-20 border-white/10 bg-white/5 text-white" />
          </div>

          {!pinDraft.pinId && !pinDraft.pendingDecision && (
            <p className="mt-3 rounded-xl border border-amber-300/20 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
              Log and sync this house first; then you can schedule an inspection.
            </p>
          )}

          {pinDraft.pendingDecision ? (
            <div className="mt-4 space-y-2">
              <div className="grid grid-cols-[auto_1fr] gap-2">
                <Button type="button" disabled={saving} onClick={openNavigation} className="h-12 border border-white/10 bg-white/10 px-4 text-white hover:bg-white/15"><Navigation className="h-4 w-4" /></Button>
                <Button type="button" disabled={saving || !dncSafetyComplete} onClick={() => retryOnePendingDecision(pinDraft.pendingDecision)} className="h-12 bg-[#2EEB57] font-black text-black hover:bg-[#39FF4A] disabled:bg-gray-800 disabled:text-gray-500">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Retry exact decision</Button>
              </div>
              {pinDraft.pendingDecision.syncState === 'needs_attention' && <div className="grid grid-cols-2 gap-2">
                <Button type="button" disabled={saving || !dncSafetyComplete} onClick={() => replacePendingLocation(pinDraft.pendingDecision)} className="h-11 border border-amber-300/20 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20">Choose new location</Button>
                <Button type="button" disabled={saving} onClick={() => discardPendingDecision(pinDraft.pendingDecision)} className="h-11 border border-red-300/20 bg-red-500/10 text-red-100 hover:bg-red-500/20">Discard pending</Button>
              </div>}
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
              <Button type="button" disabled={saving} onClick={openNavigation} className="h-12 border border-white/10 bg-white/10 px-4 text-white hover:bg-white/15"><Navigation className="h-4 w-4" /></Button>
              <Button type="button" disabled={saving || !dncSafetyComplete || !pinDraft.outcome} onClick={saveDecision} className="h-12 bg-[#2EEB57] font-black text-black hover:bg-[#39FF4A] disabled:bg-gray-800 disabled:text-gray-500">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Sync house decision
              </Button>
            </div>
          )}

          {pinDraft.pinId && !pinDraft.pendingDecision && (fieldRoutesCanvasReady || preferredPinDraftFieldRoutesStatus) && (
            <section className="mt-5 border-t border-white/10 pt-4">
              <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-200/70">FieldRoutes inspection</p>
              <ScheduleInspectionAction
                capability={fieldRoutesCapability}
                mode="canvas"
                status={preferredPinDraftFieldRoutesStatus}
                disabled={saving || !dncSafetyComplete}
                pendingDeviceCount={fieldRoutesPendingDeviceCount}
                onDiscardDeviceAttention={typeof onDiscardFieldRoutesDeviceAttention === 'function'
                  ? () => onDiscardFieldRoutesDeviceAttention(fieldRoutesSourceKey)
                  : undefined}
                onSubmit={scheduleCanvasInspection}
                initialValues={{
                  streetAddress: pinDraft.address || '',
                  unit: pinDraft.unitLabel || '',
                  notes: pinDraft.note || '',
                }}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
