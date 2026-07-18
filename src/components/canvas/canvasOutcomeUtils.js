export const CANVAS_OUTCOMES = [
  { value: 'no_answer', label: 'No answer', color: '#F59E0B' },
  { value: 'not_interested', label: 'Not interested', color: '#EF4444' },
  { value: 'callback', label: 'Callback', color: '#60A5FA' },
  { value: 'appointment', label: 'Appointment', color: '#A855F7' },
  { value: 'sale', label: 'Sale', color: '#2EEB57' },
  { value: 'do_not_knock', label: 'Do not knock', color: '#111827' },
];

const OUTCOME_BY_VALUE = new Map(CANVAS_OUTCOMES.map((outcome) => [outcome.value, outcome]));

export function getCanvasOutcome(value) {
  return OUTCOME_BY_VALUE.get(String(value || '').toLowerCase()) || {
    value: value || 'unlogged',
    label: value ? String(value).replace(/_/g, ' ') : 'Unlogged',
    color: '#94A3B8',
  };
}

export function normalizeCanvasPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const lat = Number(point?.lat ?? point?.latitude);
  const lng = Number(point?.lng ?? point?.longitude ?? point?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function normalizeCanvasRing(value) {
  if (Array.isArray(value)) return value.map(normalizeCanvasPoint).filter(Boolean);
  if (value?.type === 'Polygon') return (value.coordinates?.[0] || []).map(normalizeCanvasPoint).filter(Boolean);
  return [];
}

function normalizeCanvasStreetSegment(segment, fallbackWorkUnitId = null) {
  const start = normalizeCanvasPoint(segment?.start || segment?.from || segment?.coordinates?.[0]);
  const end = normalizeCanvasPoint(segment?.end || segment?.to || segment?.coordinates?.[1]);
  if (!start || !end) return null;
  return {
    ...segment,
    start,
    end,
    work_unit_id: String(segment?.work_unit_id || segment?.workUnitId || fallbackWorkUnitId || ''),
    street_names: segment?.street_names || segment?.streetNames || [],
  };
}

export function canvasZoneStreetSegments(zone, workUnits = []) {
  const direct = (Array.isArray(zone?.street_segments) ? zone.street_segments : [])
    .map((segment) => normalizeCanvasStreetSegment(segment))
    .filter(Boolean);
  if (direct.length) return direct;

  const zoneUnitIds = new Set((zone?.work_unit_ids || zone?.street_work_unit_ids || []).map(String));
  return (Array.isArray(workUnits) ? workUnits : [])
    .filter((unit) => !zoneUnitIds.size || zoneUnitIds.has(String(unit?.id || unit?.work_unit_id || '')))
    .flatMap((unit) => (Array.isArray(unit?.segments) ? unit.segments : [])
      .map((segment) => normalizeCanvasStreetSegment(segment, unit?.id || unit?.work_unit_id))
      .filter(Boolean));
}

export function normalizeCanvasPin(pin) {
  const point = normalizeCanvasPoint(pin);
  if (!point) return null;
  return {
    ...pin,
    ...point,
    pin_id: String(pin?.pin_id || pin?.id || ''),
    latest_outcome: String(pin?.latest_outcome || pin?.outcome || ''),
    unit_label: String(pin?.unit_label || pin?.unitLabel || ''),
  };
}

export function formatCanvasDistance(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value) || value <= 0) return 'Street workload unavailable';
  const miles = value / 1609.344;
  return miles < 0.1 ? `${Math.round(value)} m of streets` : `${miles.toFixed(miles < 1 ? 2 : 1)} mi of streets`;
}

export function canvasZoneLoggedCount(value) {
  if (value && typeof value === 'object') {
    const explicit = value.total_pins ?? value.total ?? value.logged;
    if (Number.isFinite(Number(explicit))) return Math.max(0, Number(explicit));
    return Math.max(0, Object.values(value.outcomes || {}).reduce((sum, count) => sum + (Number(count) || 0), 0));
  }
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}
