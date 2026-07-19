import React, { useEffect, useState } from 'react';
import { LayerGroup, Polyline, Tooltip } from 'react-leaflet';
import {
  CANVAS_RESIDENTIAL_ROLE_META,
  getCanvasClassifiedStreetUnits,
  getCanvasResidentialRole,
  getCanvasResidentialStreetSegments,
} from '@/components/canvas/canvasResidentialPresentation';

function opportunityLabel(unit) {
  const opportunity = unit?.opportunity || unit?.residential_opportunity;
  const expected = Number(opportunity?.expected ?? unit?.opportunity_expected);
  if (!Number.isFinite(expected) || expected < 0) return '';
  const low = Number(opportunity?.low ?? unit?.opportunity_low ?? expected);
  const high = Number(opportunity?.high ?? unit?.opportunity_high ?? expected);
  return `${Math.round(low)}-${Math.round(high)} homes (about ${Math.round(expected)})`;
}

export default function CanvasResidentialAnalysisLayers({ analysis, hasAreaPreview = false }) {
  const [selectedUnitId, setSelectedUnitId] = useState('');
  const units = getCanvasClassifiedStreetUnits(analysis);
  useEffect(() => {
    const handleSelection = (event) => setSelectedUnitId(String(event.detail?.streetUnitId || ''));
    window.addEventListener('fk-canvas-classification-unit-selected', handleSelection);
    return () => window.removeEventListener('fk-canvas-classification-unit-selected', handleSelection);
  }, []);
  if (!units.length) return null;

  return (
    <LayerGroup>
      {units.map((unit, index) => {
        const role = getCanvasResidentialRole(unit);
        const meta = CANVAS_RESIDENTIAL_ROLE_META[role];
        const segments = getCanvasResidentialStreetSegments(unit);
        if (!segments.length) return null;
        const paths = segments.map((segment) => [segment.start, segment.end]);
        const subduedByAreaPreview = hasAreaPreview && role === 'knock';
        const streetNames = unit?.streetNames || unit?.street_names || [];
        const name = Array.isArray(streetNames) ? streetNames.filter(Boolean).join(' / ') : String(streetNames || '');
        const opportunity = opportunityLabel(unit);
        const unitId = String(unit?.id || unit?.street_unit_id || '');
        const selected = unitId && selectedUnitId === unitId;
        return (
          <Polyline
            key={unit?.id || unit?.street_unit_id || `canvas-residential-unit-${index}`}
            positions={paths}
            bubblingMouseEvents={false}
            eventHandlers={role === 'uncertain' ? {
              click: () => {
                setSelectedUnitId(unitId);
                window.dispatchEvent(new CustomEvent('fk-canvas-classification-unit-requested', {
                  detail: { streetUnitId: unitId },
                }));
              },
            } : undefined}
            pathOptions={{
              color: meta.color,
              opacity: selected ? 1 : subduedByAreaPreview ? 0.22 : role === 'excluded' ? 0.65 : 0.9,
              weight: selected ? 10 : subduedByAreaPreview ? 8 : role === 'uncertain' ? 7 : 5,
              dashArray: role === 'transit_only' ? '9 8' : role === 'excluded' ? '3 8' : undefined,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          >
            <Tooltip sticky>
              <strong>{meta.label}</strong>
              {name ? <><br />{name}</> : null}
              {opportunity ? <><br />{opportunity}</> : null}
              {unit?.confidence ? <><br />Confidence: {String(unit.confidence).replaceAll('_', ' ')}</> : null}
            </Tooltip>
          </Polyline>
        );
      })}
    </LayerGroup>
  );
}
