import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from './leafletPatches';
import {
  CANVAS_RESIDENTIAL_ROLE_META,
  getCanvasClassifiedProperties,
  getCanvasClassifiedStreetUnits,
  getCanvasResidentialRole,
  getCanvasResidentialStreetSegments,
} from '@/components/canvas/canvasResidentialPresentation';

function opportunityLabel(unit) {
  const opportunity = unit?.opportunity || unit?.residential_opportunity;
  const expected = Number(opportunity?.expected ?? unit?.opportunity_expected);
  if (!Number.isFinite(expected) || expected < 0) return '';
  const low = Number(opportunity?.min ?? opportunity?.low ?? unit?.opportunity_low ?? expected);
  const high = Number(opportunity?.max ?? opportunity?.high ?? unit?.opportunity_high ?? expected);
  return `${Math.round(low)}–${Math.round(high)} homes (about ${Math.round(expected)})`;
}

function featureForUnit(unit, index) {
  const segments = getCanvasResidentialStreetSegments(unit);
  if (!segments.length) return null;
  const role = getCanvasResidentialRole(unit);
  const streetNames = unit?.streetNames || unit?.street_names || [];
  return {
    type: 'Feature',
    id: String(unit?.id || unit?.street_unit_id || unit?.work_unit_id || `canvas-residential-unit-${index}`),
    properties: {
      role,
      name: Array.isArray(streetNames) ? streetNames.filter(Boolean).join(' / ') : String(streetNames || ''),
      opportunity: opportunityLabel(unit),
      confidence: unit?.confidence ? String(unit.confidence).replaceAll('_', ' ') : '',
    },
    geometry: {
      type: 'MultiLineString',
      coordinates: segments.map((segment) => [
        [Number(segment.start.lng), Number(segment.start.lat)],
        [Number(segment.end.lng), Number(segment.end.lat)],
      ]),
    },
  };
}

function featureStyle(feature, hasAreaPreview, selectedId) {
  const role = feature?.properties?.role || 'uncertain';
  const selected = String(feature?.id || '') === selectedId;
  const subdued = hasAreaPreview && role === 'knock';
  return {
    color: CANVAS_RESIDENTIAL_ROLE_META[role]?.color || CANVAS_RESIDENTIAL_ROLE_META.uncertain.color,
    opacity: selected ? 1 : subdued ? 0.2 : role === 'excluded' ? 0.6 : 0.9,
    weight: selected ? 10 : subdued ? 7 : role === 'uncertain' ? 7 : 5,
    dashArray: role === 'transit_only' ? '9 8' : role === 'excluded' ? '3 8' : undefined,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: role === 'uncertain',
  };
}

function tooltipNode(feature) {
  const container = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = CANVAS_RESIDENTIAL_ROLE_META[feature.properties.role]?.label || 'Needs review';
  container.append(title);
  [feature.properties.name, feature.properties.opportunity,
    feature.properties.confidence ? `Confidence: ${feature.properties.confidence}` : '']
    .filter(Boolean)
    .forEach((line) => {
      container.append(document.createElement('br'), document.createTextNode(line));
    });
  return container;
}

export default function CanvasResidentialAnalysisLayers({ analysis, hasAreaPreview = false }) {
  const map = useMap();
  const layerRef = useRef(null);
  const selectedUnitIdRef = useRef('');
  const propertyAuthoritative = getCanvasClassifiedProperties(analysis).length > 0;

  useEffect(() => {
    const features = getCanvasClassifiedStreetUnits(analysis).map(featureForUnit).filter(Boolean);
    if (!features.length) return undefined;
    const renderer = L.canvas({ padding: 0.35, tolerance: 8 });
    let layer;
    layer = L.geoJSON({ type: 'FeatureCollection', features }, {
      renderer,
      style: (feature) => featureStyle(feature, hasAreaPreview, selectedUnitIdRef.current),
      onEachFeature: (feature, featureLayer) => {
        featureLayer.bindTooltip(tooltipNode(feature), { sticky: true });
        if (!propertyAuthoritative && feature.properties.role === 'uncertain') {
          featureLayer.on('click', () => {
            selectedUnitIdRef.current = String(feature.id || '');
            layer.setStyle((candidate) => featureStyle(candidate, hasAreaPreview, selectedUnitIdRef.current));
            window.dispatchEvent(new CustomEvent('fk-canvas-classification-unit-requested', {
              detail: { unitId: selectedUnitIdRef.current },
            }));
          });
        }
      },
    });
    layerRef.current = layer;
    layer.addTo(map);
    return () => {
      if (layerRef.current === layer) layerRef.current = null;
      layer.remove();
    };
  }, [analysis, hasAreaPreview, map, propertyAuthoritative]);

  useEffect(() => {
    const handleSelection = (event) => {
      selectedUnitIdRef.current = String(event.detail?.unitId || '');
      layerRef.current?.setStyle((feature) => featureStyle(feature, hasAreaPreview, selectedUnitIdRef.current));
    };
    window.addEventListener('fk-canvas-classification-unit-selected', handleSelection);
    return () => window.removeEventListener('fk-canvas-classification-unit-selected', handleSelection);
  }, [hasAreaPreview]);

  return null;
}