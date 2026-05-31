import React, { useEffect, useState } from 'react';
import CanvasZoneLayers from './CanvasZoneLayers';

export default function CanvasZoneOverlay() {
  const [zones, setZones] = useState(() => {
    try {
      const saved = localStorage.getItem('fk_canvasZones');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const handleUpdate = (event) => {
      const nextZones = event.detail?.zones;
      setZones(Array.isArray(nextZones) ? nextZones : []);
    };
    window.addEventListener('fk-canvas-zones-updated', handleUpdate);
    return () => window.removeEventListener('fk-canvas-zones-updated', handleUpdate);
  }, []);

  return <CanvasZoneLayers zones={zones} />;
}