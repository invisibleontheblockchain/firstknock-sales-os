import React from 'react';
import { CircleMarker, LayerGroup, Tooltip } from 'react-leaflet';
import { getCanvasClassifiedProperties } from '@/components/canvas/canvasResidentialPresentation';

const COLORS = { eligible: '#22C55E', excluded: '#64748B', review: '#F59E0B' };

export default function CanvasPropertyClassificationLayers({ analysis }) {
  const properties = getCanvasClassifiedProperties(analysis).filter((property) => (
    Number.isFinite(Number(property?.point?.lat)) && Number.isFinite(Number(property?.point?.lng))
  ));
  if (!properties.length) return null;
  return <LayerGroup>{properties.map((property) => {
    const state = property.canvass_eligibility || 'review';
    return <CircleMarker key={property.property_id} center={[property.point.lat, property.point.lng]} radius={state === 'review' ? 6 : 4} pathOptions={{ color: '#FFFFFF', weight: state === 'review' ? 2 : 1, fillColor: COLORS[state] || COLORS.review, fillOpacity: state === 'excluded' ? 0.45 : 0.9 }}><Tooltip><strong>{state === 'eligible' ? 'Knockable residential' : state === 'excluded' ? 'Excluded' : 'Needs review'}</strong>{property.display_address ? <><br />{property.display_address}</> : null}<br />{property.property_type?.replaceAll('_', ' ')} · {property.confidence_percent}% confidence{property.classification_reasons?.[0] ? <><br />{property.classification_reasons[0].replaceAll('_', ' ')}</> : null}</Tooltip></CircleMarker>;
  })}</LayerGroup>;
}