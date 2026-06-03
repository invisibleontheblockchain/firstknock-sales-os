import React, { useEffect, useState } from 'react';
import CanvasZoneLayers from './CanvasZoneLayers';
import CanvasOpportunityLayers from './CanvasOpportunityLayers';

function loadZones() {
  try {
    const saved = localStorage.getItem('fk_canvasZones');
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export default function CanvasZoneOverlay() {
  const [routeMode, setRouteMode] = useState(() => {
    try { return localStorage.getItem('fk_routeMode') || 'precision'; } catch { return 'precision'; }
  });
  const [zones, setZones] = useState(loadZones);

  useEffect(() => {
    const handleModeChange = (event) => setRouteMode(event.detail?.routeMode || 'precision');
    window.addEventListener('fk-route-mode-changed', handleModeChange);
    return () => window.removeEventListener('fk-route-mode-changed', handleModeChange);
  }, []);

  useEffect(() => {
    const handleUpdate = (event) => {
      const nextZones = event.detail?.zones;
      setZones(Array.isArray(nextZones) ? nextZones : loadZones());
    };
    window.addEventListener('fk-canvas-zones-updated', handleUpdate);
    return () => window.removeEventListener('fk-canvas-zones-updated', handleUpdate);
  }, []);

  if (routeMode !== 'canvas') return null;

  return (
    <>
      <CanvasOpportunityLayers />
      <CanvasZoneLayers zones={zones} />
    </>
  );
}