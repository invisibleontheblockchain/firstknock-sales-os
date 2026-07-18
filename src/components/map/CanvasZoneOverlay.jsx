import React, { useEffect, useState } from 'react';
import CanvasZoneLayers from './CanvasZoneLayers';
import CanvasOpportunityLayers from './CanvasOpportunityLayers';

export default function CanvasZoneOverlay({ routeMode = 'precision' }) {
  const [zones, setZones] = useState([]);

  useEffect(() => {
    const handleUpdate = (event) => {
      const nextZones = event.detail?.zones;
      setZones(Array.isArray(nextZones) ? nextZones : []);
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
