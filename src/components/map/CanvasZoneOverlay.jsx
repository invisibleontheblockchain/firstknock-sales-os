import React, { useEffect, useState } from 'react';
import CanvasZoneLayers from './CanvasZoneLayers';
import CanvasCampaignMapLayers from './CanvasCampaignMapLayers';

export default function CanvasZoneOverlay({ routeMode = 'precision' }) {
  const [zones, setZones] = useState([]);
  const [workUnits, setWorkUnits] = useState([]);

  useEffect(() => {
    const handleUpdate = (event) => {
      const nextZones = event.detail?.zones;
      setZones(Array.isArray(nextZones) ? nextZones : []);
      const nextWorkUnits = event.detail?.workUnits || event.detail?.work_units;
      setWorkUnits(Array.isArray(nextWorkUnits) ? nextWorkUnits : []);
    };
    window.addEventListener('fk-canvas-zones-updated', handleUpdate);
    return () => window.removeEventListener('fk-canvas-zones-updated', handleUpdate);
  }, []);

  if (routeMode !== 'canvas') return null;

  return (
    <>
      <CanvasZoneLayers zones={zones} workUnits={workUnits} />
      <CanvasCampaignMapLayers />
    </>
  );
}
