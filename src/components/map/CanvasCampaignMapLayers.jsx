import React, { useEffect, useState } from 'react';
import { CircleMarker, LayerGroup, Polygon, Tooltip } from 'react-leaflet';
import {
  getCanvasOutcome,
  normalizeCanvasPin,
  normalizeCanvasRing,
} from '@/components/canvas/canvasOutcomeUtils';

export default function CanvasCampaignMapLayers() {
  const [campaignMap, setCampaignMap] = useState(null);

  useEffect(() => {
    const handleUpdate = (event) => setCampaignMap(event.detail || null);
    window.addEventListener('fk-canvas-campaign-map-updated', handleUpdate);
    return () => window.removeEventListener('fk-canvas-campaign-map-updated', handleUpdate);
  }, []);

  if (!campaignMap) return null;

  const campaign = campaignMap.campaign || {};
  const boundary = normalizeCanvasRing(
    campaign.polygon
      || campaign.boundary
      || campaign.global_boundary
      || campaignMap.polygon
  );
  const pins = (Array.isArray(campaignMap.pins) ? campaignMap.pins : [])
    .map(normalizeCanvasPin)
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
        const outcome = getCanvasOutcome(pin.latest_outcome);
        return (
          <CircleMarker
            key={pin.pin_id || `${pin.lat}:${pin.lng}:${index}`}
            center={[pin.lat, pin.lng]}
            radius={7}
            pathOptions={{ color: '#FFFFFF', fillColor: outcome.color, fillOpacity: 1, weight: 2 }}
          >
            <Tooltip direction="top">
              <strong>{outcome.label}</strong> · Synced
              {pin.address ? <><br />{pin.address}</> : null}
              {pin.unit_label ? <> · {pin.unit_label}</> : null}
              {pin.latest_note ? <><br />{pin.latest_note}</> : null}
              {pin.last_actor_name || pin.last_actor_team_member_id ? <><br />Rep · {pin.last_actor_name || String(pin.last_actor_team_member_id).slice(-8)}</> : null}
              {pin.last_event_at ? <><br />{new Date(pin.last_event_at).toLocaleString()}</> : null}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </LayerGroup>
  );
}
