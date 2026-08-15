import React, { useEffect, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';
import CanvasZoneLayers from './CanvasZoneLayers';
import CanvasCampaignMapLayers from './CanvasCampaignMapLayers';
import CanvasResidentialAnalysisLayers from './CanvasResidentialAnalysisLayers';
import { canvasZoneStreetSegments } from '@/components/canvas/canvasOutcomeUtils';

function previewPoints(zones, workUnits) {
  return zones.flatMap((zone) => canvasZoneStreetSegments(zone, workUnits)
    .flatMap((segment) => [segment.start, segment.end]))
    .filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng)))
    .map((point) => [Number(point.lat), Number(point.lng)]);
}

export default function CanvasZoneOverlay({ routeMode = 'precision', preview = {} }) {
  const map = useMap();
  const routeModeRef = useRef(routeMode);
  const fitFrameRef = useRef(null);
  const [zones, setZones] = useState(() => Array.isArray(preview.zones) ? preview.zones : []);
  const [workUnits, setWorkUnits] = useState(() => Array.isArray(preview.workUnits) ? preview.workUnits : []);
  const [residentialAnalysis, setResidentialAnalysis] = useState(null);
  routeModeRef.current = routeMode;

  useEffect(() => {
    setZones(Array.isArray(preview.zones) ? preview.zones : []);
    setWorkUnits(Array.isArray(preview.workUnits) ? preview.workUnits : []);
  }, [preview.workUnits, preview.zones]);

  useEffect(() => {
    const handleUpdate = (event) => {
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      const nextZones = event.detail?.zones;
      const nextWorkUnits = event.detail?.workUnits || event.detail?.work_units;
      const normalizedZones = Array.isArray(nextZones) ? nextZones : [];
      const normalizedWorkUnits = Array.isArray(nextWorkUnits) ? nextWorkUnits : [];
      setZones(normalizedZones);
      setWorkUnits(normalizedWorkUnits);
      if (routeMode !== 'canvas' || event.detail?.fitPreview !== true || !normalizedZones.length) return;
      const points = previewPoints(normalizedZones, normalizedWorkUnits);
      if (!points.length) return;
      fitFrameRef.current = window.requestAnimationFrame(() => {
        fitFrameRef.current = null;
        if (routeModeRef.current !== 'canvas') return;
        const desktop = window.innerWidth >= 1024;
        map.fitBounds(points, {
          animate: true,
          duration: 0.35,
          maxZoom: 16,
          paddingTopLeft: desktop ? [430, 24] : [20, 20],
          paddingBottomRight: desktop ? [24, 24] : [20, 92],
        });
      });
    };
    window.addEventListener('fk-canvas-zones-updated', handleUpdate);
    return () => {
      window.removeEventListener('fk-canvas-zones-updated', handleUpdate);
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      if (routeMode === 'canvas' && routeModeRef.current !== 'canvas') map.stop();
    };
  }, [map, routeMode]);

  useEffect(() => {
    const handleResidentialAnalysis = (event) => setResidentialAnalysis(event.detail?.analysis || null);
    window.addEventListener('fk-canvas-residential-analysis-updated', handleResidentialAnalysis);
    return () => window.removeEventListener('fk-canvas-residential-analysis-updated', handleResidentialAnalysis);
  }, []);

  if (routeMode !== 'canvas') return null;

  return (
    <>
      <CanvasResidentialAnalysisLayers analysis={residentialAnalysis} hasAreaPreview={zones.length > 0} />
      <CanvasZoneLayers zones={zones} workUnits={workUnits} />
      <CanvasCampaignMapLayers />
    </>
  );
}
