// Canvas workload, measured in estimated minutes rather than raw door count.
//
// Balancing raw opportunity counts treats a spread-out rural blockface and a
// dense city block as the same day of work. The spec measures workload as
//
//   expected opportunities × average attempt time
//   + walking time
//   + MDU/site overhead
//
// Street length and MDU site data come from the evidence adapter. Until that
// adapter lands, units carry neither, so every helper here degrades to the
// opportunity term alone rather than inventing a length. That keeps the
// partitioner's current behaviour byte-identical on length-free evidence and
// lets it improve automatically once real geometry arrives.

import {
  getCanvasClassifiedStreetUnits,
  getCanvasResidentialStreetSegments,
  unwrapCanvasResidentialAnalysis,
} from './canvasResidentialPresentation.js';

// Calibration provenance (checkpoint A, 2026-08-15). Read before changing a
// constant here, because only one of them has been measured.
//
// Source: a read-only aggregate over Precision `InteractionLog` knock history.
// 89 same-street pairs; 44 of them GPS-qualified. Median elapsed between logged
// knocks 5.26 min, median straight-line spacing 155.1 m (IQR 97.8-392.7).
// No-answers are logged (356 of 656 logs, 54.3%), so the intervals are not
// contact-only.
//
// Decomposed at an 80 m/min gait: 155.1 / 80 = 1.94 min walking, leaving
// ~3.32 min of attempt. Straight-line GPS understates the walked path (a
// driveway approach and retreat do not appear in it), so true walking is
// higher and true attempt is at or below 3.32. The band is roughly 2.7-3.3.
//
// What this does NOT calibrate: `walk_meters_per_minute`. Every measured
// interval contains stationary door time, so the sample cannot isolate gait —
// the 34.1 m/min "pace" it yields is an effective rate, not a walking speed.
// Nor does the spacing transfer: InteractionLog is the Precision route log,
// where reps walk between sparse selected properties. Canvas is saturation
// work along a blockface, where meters-per-door is lot frontage (~20-30 m),
// not 155 m. Feeding this spacing into the walking term would inflate every
// estimate several-fold.
//
// Recalibrate walking against Canvas's own `CanvasHouseEvent` telemetry once a
// pilot territory has been worked door to door.
export const CANVAS_WORKLOAD_DEFAULTS = Object.freeze({
  // Knock, wait, converse, log. Median across a shift, not a best case.
  // Measured: ~3.3 min, top of the 2.7-3.3 band derived above.
  attempt_minutes: 3.3,
  // Street traverse at working pace. NOT yet measured — see the note above.
  // Held at ~75% of an 80 m/min gait to absorb driveways, turns and materials.
  walk_meters_per_minute: 60,
  // Fixed cost of working one multi-dwelling site: access, lobby, stairs.
  // Not yet measured; no MDU evidence exists until the adapter lands.
  mdu_site_overhead_minutes: 12,
  // A working field hour is not 60 minutes of doors. Not yet measured.
  productive_minutes_per_hour: 50,
});

const METERS_PER_MILE = 1609.344;
const EARTH_RADIUS_METERS = 6371008.8;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function haversineMeters(start, end) {
  const lat1 = toRadians(finite(start?.lat, NaN));
  const lat2 = toRadians(finite(end?.lat, NaN));
  const lng1 = toRadians(finite(start?.lng, NaN));
  const lng2 = toRadians(finite(end?.lng, NaN));
  if (![lat1, lat2, lng1, lng2].every(Number.isFinite)) return 0;
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Street length of one work unit in meters. Prefers a length supplied by the
 * evidence adapter and falls back to measuring the unit's own geometry.
 * Returns 0 when the unit carries neither, which is the current production case.
 */
export function getCanvasUnitStreetMeters(unit) {
  const declared = finite(unit?.length_meters ?? unit?.street_length_meters, 0);
  if (declared > 0) return declared;
  return getCanvasResidentialStreetSegments(unit)
    .reduce((total, segment) => total + haversineMeters(segment.start, segment.end), 0);
}

function unitExpectedOpportunity(unit) {
  return Math.max(0, finite(unit?.opportunity?.expected ?? unit?.opportunity_expected, 0));
}

function unitMduSiteCount(unit) {
  const declared = finite(unit?.mdu_site_count ?? unit?.mdu_sites, 0);
  if (declared > 0) return declared;
  return unit?.is_mdu === true ? 1 : 0;
}

/**
 * Estimated minutes of field work for one unit. Excluded, transit, and
 * uncertain units carry zero — uncertain contributes nothing until reviewed.
 */
export function estimateCanvasUnitMinutes(unit, options = {}) {
  const config = { ...CANVAS_WORKLOAD_DEFAULTS, ...options };
  if (unit?.canvas_role && unit.canvas_role !== 'knock') return 0;
  const attemptMinutes = unitExpectedOpportunity(unit) * Math.max(0, finite(config.attempt_minutes, 0));
  const pace = Math.max(1, finite(config.walk_meters_per_minute, 1));
  const walkMinutes = getCanvasUnitStreetMeters(unit) / pace;
  const mduMinutes = unitMduSiteCount(unit) * Math.max(0, finite(config.mdu_site_overhead_minutes, 0));
  return attemptMinutes + walkMinutes + mduMinutes;
}

const CONFIDENCE_WEIGHTS = Object.freeze({
  high: 1,
  medium: 0.65,
  low: 0.3,
  unknown: 0.3,
});

function confidenceWeight(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Accept both 0–1 and 0–100 encodings.
    const scaled = value > 1 ? value / 100 : value;
    return Math.min(1, Math.max(0, scaled));
  }
  const key = String(value || '').toLowerCase().replaceAll(' ', '_');
  return CONFIDENCE_WEIGHTS[key] ?? null;
}

/**
 * Plan-level confidence as a 0–100 percentage, weighted by each unit's expected
 * opportunity so a large uncertain block moves the number more than a small one.
 * Returns null when no unit carries confidence rather than inventing a score.
 */
export function getCanvasPlanConfidencePercent(value) {
  const units = getCanvasClassifiedStreetUnits(unwrapCanvasResidentialAnalysis(value))
    .filter((unit) => !unit?.canvas_role || unit.canvas_role === 'knock');
  let weighted = 0;
  let total = 0;
  units.forEach((unit) => {
    const weight = confidenceWeight(unit?.confidence);
    if (weight === null) return;
    // Every knock unit counts at least once so a zero-opportunity unit with poor
    // confidence still drags the plan-level number down.
    const mass = Math.max(1, unitExpectedOpportunity(unit));
    weighted += weight * mass;
    total += mass;
  });
  if (total <= 0) return null;
  return Math.round((weighted / total) * 100);
}

/**
 * Everything the builder needs to report a plan honestly: the opportunity
 * range, eligible street miles, estimated field hours, confidence, and the
 * number of pockets still awaiting review.
 */
export function summarizeCanvasPlanWorkload(value, options = {}) {
  const config = { ...CANVAS_WORKLOAD_DEFAULTS, ...options };
  const analysis = unwrapCanvasResidentialAnalysis(value);
  const units = getCanvasClassifiedStreetUnits(analysis);
  const knockUnits = units.filter((unit) => unit?.canvas_role === 'knock');

  const streetMeters = knockUnits.reduce((total, unit) => total + getCanvasUnitStreetMeters(unit), 0);
  const minutes = knockUnits.reduce((total, unit) => total + estimateCanvasUnitMinutes(unit, config), 0);
  const productive = Math.max(1, finite(config.productive_minutes_per_hour, 60));

  return {
    eligible_street_meters: streetMeters,
    eligible_street_miles: streetMeters / METERS_PER_MILE,
    estimated_minutes: minutes,
    estimated_hours: minutes / productive,
    confidence_percent: getCanvasPlanConfidencePercent(analysis),
    uncertain_unit_count: units.filter((unit) => unit?.canvas_role === 'uncertain').length,
    knock_unit_count: knockUnits.length,
    // Zero street meters means the evidence carries no geometry, so the hours
    // figure is opportunity-only. Callers surface this rather than implying
    // a walking estimate that was never made.
    has_street_geometry: streetMeters > 0,
  };
}

/**
 * A non-binding suggestion for the number of areas, derived from whatever
 * target the organisation actually works to. Never forces the value.
 */
export function recommendCanvasAreaCount(summary, options = {}) {
  const targetHours = finite(options.target_hours_per_area, 0);
  const targetDoors = finite(options.target_doors_per_area, 0);
  const maximum = Math.max(1, Math.trunc(finite(options.maximum_areas, 250)));

  let raw = null;
  if (targetHours > 0 && finite(summary?.estimated_hours, 0) > 0) {
    raw = summary.estimated_hours / targetHours;
  } else if (targetDoors > 0 && finite(options.expected_opportunities, 0) > 0) {
    raw = options.expected_opportunities / targetDoors;
  }
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;

  const basis = targetHours > 0 && finite(summary?.estimated_hours, 0) > 0 ? 'field_hours' : 'doors';
  return { count: Math.min(maximum, Math.max(1, Math.round(raw))), basis };
}

/**
 * "5,800–6,400" — never a single confident number. A zero-width range still
 * renders as one value so an exact count does not read as a fake spread.
 */
export function formatCanvasOpportunityRange(range) {
  const low = Math.round(finite(range?.low, NaN));
  const high = Math.round(finite(range?.high, NaN));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (low === high) return low.toLocaleString();
  return `${low.toLocaleString()}–${high.toLocaleString()}`;
}

export function formatCanvasStreetMiles(miles) {
  const value = finite(miles, NaN);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString()} mi`;
}

export function formatCanvasFieldHours(hours) {
  const value = finite(hours, NaN);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 10) return `${value.toFixed(1)} hrs`;
  return `${Math.round(value).toLocaleString()} hrs`;
}
