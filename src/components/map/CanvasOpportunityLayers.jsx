import React, { useEffect, useState } from 'react';
import { CircleMarker, LayerGroup, Polygon, Tooltip } from 'react-leaflet';

function loadAnalysis() {
  try {
    if (window.__fkCanvasAnalysis) return window.__fkCanvasAnalysis;
    const saved = sessionStorage.getItem('fk_canvasAnalysis');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function geoJsonToPositions(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map((ring) => ring.map(([lng, lat]) => ({ lat, lng })));
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))));
  }
  return [];
}

function excludedLabel(type = 'excluded') {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function CanvasOpportunityLayers() {
  const [analysis, setAnalysis] = useState(loadAnalysis);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const handleUpdate = (event) => setAnalysis(event.detail?.analysis || loadAnalysis());
    const handleVisibility = (event) => setVisible(event.detail?.visible !== false);
    window.addEventListener('fk-canvas-analysis-updated', handleUpdate);
    window.addEventListener('fk-canvas-opportunity-layer-visibility', handleVisibility);
    return () => {
      window.removeEventListener('fk-canvas-analysis-updated', handleUpdate);
      window.removeEventListener('fk-canvas-opportunity-layer-visibility', handleVisibility);
    };
  }, []);

  if (!visible || !analysis) return null;

  const opportunities = Array.isArray(analysis.opportunities) ? analysis.opportunities : [];
  const excludedAreas = Array.isArray(analysis.excludedAreas) ? analysis.excludedAreas : [];

  return (
    <LayerGroup>
      {excludedAreas.flatMap((area) => geoJsonToPositions(area.geometry).map((positions, index) => (
        <Polygon
          key={`${area.id || area.type}-${index}`}
          positions={positions}
          pathOptions={{ color: '#EF4444', fillColor: '#EF4444', fillOpacity: 0.28, weight: 2 }}
        >
          <Tooltip direction="center" sticky>
            Excluded — {excludedLabel(area.name || area.type)}
          </Tooltip>
        </Polygon>
      )))}

      {opportunities.slice(0, 5000).map((opp) => (
        <CircleMarker
          key={opp.id || `${opp.lat}-${opp.lng}`}
          center={[opp.lat, opp.lng]}
          radius={3.5}
          pathOptions={{ color: '#052e16', fillColor: '#22C55E', fillOpacity: 0.92, weight: 1 }}
        >
          <Tooltip direction="top">
            Opportunity — {opp.classificationConfidence || 'BUILDING'}
          </Tooltip>
        </CircleMarker>
      ))}
    </LayerGroup>
  );
}