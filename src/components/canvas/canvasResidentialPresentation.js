const ROLE_ALIASES = Object.freeze({
  knock: 'knock',
  likely: 'knock',
  residential: 'knock',
  transit: 'transit_only',
  transit_only: 'transit_only',
  connector: 'transit_only',
  excluded: 'excluded',
  commercial: 'excluded',
  non_residential: 'excluded',
  uncertain: 'uncertain',
  unknown: 'uncertain',
  amber: 'uncertain',
});

export const CANVAS_RESIDENTIAL_ROLE_META = Object.freeze({
  knock: {
    label: 'Likely residential',
    detail: 'Positive residential evidence; included in workload.',
    color: '#22C55E',
  },
  transit_only: {
    label: 'Transit context',
    detail: 'Useful for orientation or connectivity; no knock workload.',
    color: '#94A3B8',
  },
  excluded: {
    label: 'Commercial / open land',
    detail: 'Affirmative non-residential evidence; shown as context only.',
    color: '#475569',
  },
  uncertain: {
    label: 'Needs review',
    detail: 'Missing or conflicting evidence; never silently excluded.',
    color: '#F59E0B',
  },
});

export function unwrapCanvasResidentialAnalysis(value) {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return null;
    if (Array.isArray(current.classified_street_units) || Array.isArray(current.street_units)) return current;
    const next = current.analysis_result || current.analysis || current.result || current.evidence?.analysis_result;
    if (!next || next === current) return current;
    current = next;
  }
  return current && typeof current === 'object' ? current : null;
}

export function getCanvasClassifiedStreetUnits(value) {
  const analysis = unwrapCanvasResidentialAnalysis(value);
  const units = analysis?.classified_street_units || analysis?.street_units || analysis?.work_units;
  return Array.isArray(units) ? units : [];
}

export function getCanvasResidentialRole(unit) {
  const raw = String(
    unit?.canvas_role
      || unit?.role
      || unit?.classification
      || unit?.opportunity_classification
      || 'uncertain'
  ).trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return ROLE_ALIASES[raw] || 'uncertain';
}

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function summaryCount(summary, role) {
  const aliases = {
    knock: ['knock', 'likely', 'residential', 'knock_count', 'likely_count'],
    transit_only: ['transit_only', 'transit', 'connector', 'transit_only_count', 'transit_count'],
    excluded: ['excluded', 'commercial', 'non_residential', 'excluded_count', 'commercial_count'],
    uncertain: ['uncertain', 'amber', 'unknown', 'uncertain_count', 'amber_count'],
  }[role];
  for (const key of aliases) {
    const count = finiteCount(summary?.[key]);
    if (count !== null) return count;
  }
  return 0;
}

export function getCanvasResidentialRoleCounts(value) {
  const analysis = unwrapCanvasResidentialAnalysis(value);
  const units = getCanvasClassifiedStreetUnits(analysis);
  if (units.length) {
    return units.reduce((counts, unit) => {
      counts[getCanvasResidentialRole(unit)] += 1;
      return counts;
    }, { knock: 0, transit_only: 0, excluded: 0, uncertain: 0 });
  }
  const summary = analysis?.summary?.role_counts
    || analysis?.summary?.canvas_role_counts
    || analysis?.role_counts
    || analysis?.canvas_role_counts
    || analysis?.summary
    || {};
  return {
    knock: summaryCount(summary, 'knock'),
    transit_only: summaryCount(summary, 'transit_only'),
    excluded: summaryCount(summary, 'excluded'),
    uncertain: summaryCount(summary, 'uncertain'),
  };
}

function normalizeOpportunity(value) {
  const source = value?.opportunity || value?.residential_opportunity || value;
  const expected = finiteCount(source?.expected ?? source?.opportunity_expected ?? source?.expected_units);
  if (expected === null) return null;
  const low = finiteCount(source?.low ?? source?.opportunity_low ?? source?.low_units) ?? expected;
  const high = finiteCount(source?.high ?? source?.opportunity_high ?? source?.high_units) ?? expected;
  return { low, expected, high };
}

function opportunityRecords(value) {
  const analysis = unwrapCanvasResidentialAnalysis(value);
  const direct = analysis?.opportunity_by_street_unit;
  if (Array.isArray(direct)) {
    return new Map(direct.map((record) => [String(record?.street_unit_id || record?.id || ''), normalizeOpportunity(record)]));
  }
  if (direct && typeof direct === 'object') {
    return new Map(Object.entries(direct).map(([id, record]) => [String(id), normalizeOpportunity(record)]));
  }
  return new Map(getCanvasClassifiedStreetUnits(analysis).map((unit) => [
    String(unit?.id || unit?.street_unit_id || unit?.work_unit_id || ''),
    normalizeOpportunity(unit),
  ]));
}

export function getCanvasResidentialOpportunitySummary(value) {
  const analysis = unwrapCanvasResidentialAnalysis(value);
  const records = [...opportunityRecords(analysis).values()].filter(Boolean);
  if (records.length) {
    return records.reduce((total, range) => ({
      low: total.low + range.low,
      expected: total.expected + range.expected,
      high: total.high + range.high,
      covered_units: total.covered_units + 1,
    }), { low: 0, expected: 0, high: 0, covered_units: 0 });
  }
  const summary = analysis?.summary || analysis?.opportunity_summary || {};
  const range = normalizeOpportunity(summary?.opportunity || summary?.residential_opportunity || summary);
  return range ? { ...range, covered_units: finiteCount(summary.covered_units) || 0 } : null;
}

export function getCanvasZoneResidentialOpportunity(zone, analysis) {
  const ids = zone?.work_unit_ids || zone?.street_work_unit_ids || [];
  const records = opportunityRecords(analysis);
  const ranges = ids.map((id) => records.get(String(id))).filter(Boolean);
  if (!ranges.length) return null;
  return ranges.reduce((total, range) => ({
    low: total.low + range.low,
    expected: total.expected + range.expected,
    high: total.high + range.high,
    covered_units: total.covered_units + 1,
  }), { low: 0, expected: 0, high: 0, covered_units: 0 });
}

function normalizePoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const lat = Number(point?.lat ?? point?.latitude);
  const lng = Number(point?.lng ?? point?.longitude ?? point?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function getCanvasResidentialStreetSegments(unit) {
  const direct = unit?.segments || unit?.street_segments || [];
  const segments = (Array.isArray(direct) ? direct : []).map((segment) => {
    const start = normalizePoint(segment?.start || segment?.from || segment?.coordinates?.[0]);
    const end = normalizePoint(segment?.end || segment?.to || segment?.coordinates?.[1]);
    return start && end ? { ...segment, start, end } : null;
  }).filter(Boolean);
  if (segments.length) return segments;
  const coordinates = unit?.geometry?.type === 'LineString' ? unit.geometry.coordinates : unit?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  const points = coordinates.map(normalizePoint).filter(Boolean);
  return points.slice(1).map((end, index) => ({ start: points[index], end }));
}
