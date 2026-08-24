// Estimation helpers for the public /find acquisition page.
// Anonymous visitors never see real property data — the teaser count and pin
// spread are derived deterministically from the drawn polygon so the same
// territory always shows the same preview.

const EARTH_MILE_PER_DEG_LAT = 69.05;

export function polygonAreaSqMi(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const milePerDegLng = EARTH_MILE_PER_DEG_LAT * Math.cos((meanLat * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += (a.lng * milePerDegLng) * (b.lat * EARTH_MILE_PER_DEG_LAT)
      - (b.lng * milePerDegLng) * (a.lat * EARTH_MILE_PER_DEG_LAT);
  }
  return Math.abs(area) / 2;
}

// Small deterministic PRNG seeded from the polygon geometry.
function seedFromPolygon(points) {
  let seed = 2166136261;
  points.forEach((p) => {
    const s = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    for (let i = 0; i < s.length; i += 1) {
      seed ^= s.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
  });
  return () => {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
    return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
  };
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat)
      && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

// Suburban single-family density with a typical annual ownership turnover,
// prorated to the chosen lookback window.
export function estimateHomeowners(points, lookbackDays) {
  const area = polygonAreaSqMi(points);
  if (area <= 0) return 0;
  const rand = seedFromPolygon(points);
  const homesPerSqMi = 480 + rand() * 220;
  const annualTurnover = 0.062 + rand() * 0.03;
  const raw = area * homesPerSqMi * annualTurnover * (lookbackDays / 365);
  return Math.max(4, Math.round(raw));
}

// Scatter preview pins inside the polygon — capped so the map reads as a
// teaser, not a full result set.
export function teaserPoints(points, count) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const rand = seedFromPolygon(points);
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const target = Math.min(count, 40);
  const out = [];
  let attempts = 0;
  while (out.length < target && attempts < target * 30) {
    attempts += 1;
    const candidate = {
      lat: minLat + rand() * (maxLat - minLat),
      lng: minLng + rand() * (maxLng - minLng),
    };
    if (pointInPolygon(candidate, points)) out.push(candidate);
  }
  return out;
}