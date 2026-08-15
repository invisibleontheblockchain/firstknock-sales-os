import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CircleMarker, LayerGroup, Polygon, Tooltip, useMap } from 'react-leaflet';
import { getCanvasViewportPins } from '@/components/canvas/canvasProductionClient';
import { isCanvasDncProtected } from '@/components/canvas/canvasDncSafety';
import {
  getCanvasOutcome,
  normalizeCanvasPin,
  normalizeCanvasRing,
} from '@/components/canvas/canvasOutcomeUtils';

export default function CanvasCampaignMapLayers() {
  const map = useMap();
  const [campaignMap, setCampaignMap] = useState(null);
  const [viewportPins, setViewportPins] = useState([]);
  const [viewportDnc, setViewportDnc] = useState([]);
  const requestRef = useRef(0);
  const refreshTimerRef = useRef(null);

  useEffect(() => {
    const handleUpdate = (event) => setCampaignMap(event.detail || null);
    window.addEventListener('fk-canvas-campaign-map-updated', handleUpdate);
    return () => window.removeEventListener('fk-canvas-campaign-map-updated', handleUpdate);
  }, []);

  const campaignId = String(campaignMap?.campaign?.campaign_id || campaignMap?.campaign?.session_id || '');
  const viewportMode = campaignMap?.viewport_decisions === true && Boolean(campaignId);

  const loadViewport = useCallback(async () => {
    if (!viewportMode || !campaignId) return;
    const bounds = map.getBounds();
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const allPins = [];
    const allDnc = [];
    let afterCursor = 0;
    let afterId = '';
    let truncated = false;
    try {
      for (let page = 0; page < 10; page += 1) {
        const result = await getCanvasViewportPins({
          campaignId,
          bounds: { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() },
          afterCursor,
          afterId,
          limit: 500,
        });
        if (requestRef.current !== requestId) return;
        allPins.push(...(result.pins || []));
        allDnc.push(...(result.dnc || []));
        if (!result.has_more) break;
        afterCursor = Number(result.next_cursor || 0);
        afterId = String(result.next_id || '');
        if (page === 9) truncated = true;
      }
      if (requestRef.current !== requestId) return;
      setViewportPins(allPins);
      setViewportDnc(allDnc);
      window.dispatchEvent(new CustomEvent('fk-canvas-viewport-status', {
        detail: { campaignId, loading: false, error: '', truncated, count: allPins.length + allDnc.length },
      }));
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setViewportPins([]);
      setViewportDnc([]);
      window.dispatchEvent(new CustomEvent('fk-canvas-viewport-status', {
        detail: { campaignId, loading: false, error: error?.message || 'Visible Canvas decisions could not be loaded.', truncated: false, count: 0 },
      }));
    }
  }, [campaignId, map, viewportMode]);

  useEffect(() => {
    if (!viewportMode) {
      requestRef.current += 1;
      setViewportPins([]);
      setViewportDnc([]);
      return undefined;
    }
    setViewportPins([]);
    setViewportDnc([]);
    window.dispatchEvent(new CustomEvent('fk-canvas-viewport-status', {
      detail: { campaignId, loading: true, error: '', truncated: false, count: 0 },
    }));
    const schedule = () => {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(loadViewport, 250);
    };
    const refresh = () => loadViewport();
    schedule();
    map.on('moveend zoomend', schedule);
    window.addEventListener('focus', refresh);
    window.addEventListener('fk-canvas-viewport-refresh-requested', refresh);
    const interval = window.setInterval(refresh, 5 * 60_000);
    return () => {
      requestRef.current += 1;
      window.clearTimeout(refreshTimerRef.current);
      window.clearInterval(interval);
      map.off('moveend zoomend', schedule);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('fk-canvas-viewport-refresh-requested', refresh);
    };
  }, [campaignId, loadViewport, map, viewportMode]);

  if (!campaignMap) return null;

  const campaign = campaignMap.campaign || {};
  const boundary = normalizeCanvasRing(
    campaign.polygon
      || campaign.boundary
      || campaign.global_boundary
      || campaignMap.polygon
  );
  const pins = (viewportMode ? viewportPins : Array.isArray(campaignMap.pins) ? campaignMap.pins : [])
    .map(normalizeCanvasPin)
    .filter(Boolean);
  const dncPins = (viewportMode ? viewportDnc : [])
    .map((entry) => normalizeCanvasPin({
      pin_id: `dnc:${entry.suppression_id}`,
      house_key: entry?.house_key,
      lat: entry?.point?.lat ?? entry?.lat,
      lng: entry?.point?.lng ?? entry?.lng,
      latest_outcome: 'do_not_knock',
      dnc_active: true,
      read_only_dnc: true,
    }))
    .filter(Boolean);

  return (
    <LayerGroup>
      {boundary.length >= 3 && (
        <Polygon
          positions={boundary}
          interactive={false}
          pathOptions={{ color: '#FFFFFF', fillOpacity: 0, opacity: 0.9, weight: 3, dashArray: '7 7' }}
        >
          <Tooltip sticky>Global Canvas campaign boundary</Tooltip>
        </Polygon>
      )}
      {pins.map((pin, index) => {
        const protectedDnc = isCanvasDncProtected(pin);
        const outcome = getCanvasOutcome(protectedDnc ? 'do_not_knock' : pin.latest_outcome);
        return (
          <CircleMarker
            key={pin.pin_id || `${pin.lat}:${pin.lng}:${index}`}
            center={[pin.lat, pin.lng]}
            radius={protectedDnc ? 9 : 7}
            pathOptions={{ color: protectedDnc ? '#F87171' : '#FFFFFF', fillColor: protectedDnc ? '#111827' : outcome.color, fillOpacity: 1, weight: protectedDnc ? 3 : 2 }}
          >
            <Tooltip direction="top">
              <strong>{protectedDnc ? 'Team do not knock' : outcome.label}</strong> · {protectedDnc ? 'Protected across Canvas campaigns' : 'Synced'}
              {pin.address ? <><br />{pin.address}</> : null}
              {pin.unit_label ? <> · {pin.unit_label}</> : null}
              {pin.latest_note ? <><br />{pin.latest_note}</> : null}
              {pin.last_actor_name || pin.last_actor_team_member_id ? <><br />Rep · {pin.last_actor_name || String(pin.last_actor_team_member_id).slice(-8)}</> : null}
              {pin.last_event_at ? <><br />{new Date(pin.last_event_at).toLocaleString()}</> : null}
            </Tooltip>
          </CircleMarker>
        );
      })}
      {dncPins.map((pin) => (
        <CircleMarker key={pin.pin_id} center={[pin.lat, pin.lng]} radius={9} pathOptions={{ color: '#F87171', fillColor: '#111827', fillOpacity: 1, weight: 3 }}>
          <Tooltip direction="top"><strong>Team do not knock</strong><br />Protected across Canvas campaigns</Tooltip>
        </CircleMarker>
      ))}
    </LayerGroup>
  );
}
