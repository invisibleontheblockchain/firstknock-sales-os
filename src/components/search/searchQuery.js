// Query classification, normalization and ranking for the unified map search.
// Pure functions only — the hook and the services stay testable without a DOM.

export const MIN_SEARCH_LENGTH = 2;

const STREET_SUFFIX_WORDS = new Set([
  'st', 'street', 'rd', 'road', 'ave', 'avenue', 'av', 'dr', 'drive', 'ln', 'lane',
  'ct', 'court', 'cir', 'circle', 'blvd', 'boulevard', 'pl', 'place', 'ter', 'terrace',
  'trl', 'trail', 'pkwy', 'parkway', 'hwy', 'highway', 'way',
]);

const STATE_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
  'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt',
  'va', 'wa', 'wv', 'wi', 'wy', 'dc',
]);

export function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Progressive intent resolution. Internal records are always searched; the
 * external geocoder is only reached when the query is genuinely location-like,
 * so typing a person's name never leaves the account.
 */
export function classifyQuery(rawQuery) {
  const query = String(rawQuery || '').trim();
  const normalized = normalizeSearchText(query);
  const tokens = normalized ? normalized.split(' ') : [];
  const usable = normalized.length >= MIN_SEARCH_LENGTH;

  const county = /\bcount(y|ies)\b/i.test(query);
  const hasHouseNumber = /^\d+\s+\S/.test(query.trim());
  const hasStreetSuffix = tokens.some((token) => STREET_SUFFIX_WORDS.has(token));
  const hasZip = /\b\d{5}(-\d{4})?\b/.test(query);
  const hasStateCode = tokens.some((token) => STATE_CODES.has(token));

  return {
    query,
    normalized,
    usable,
    searchInternal: usable,
    searchCounty: usable && county,
    // A city lookup needs a place-like query: no house number, street suffix or
    // ZIP. Multi-word place names ("Myrtle Beach", "New York") qualify, and the
    // provider's city featureType returns nothing for a person's name.
    searchCity: usable && !county && !hasHouseNumber && !hasStreetSuffix && !hasZip
      && tokens.length <= 4,
    // "Amanda" is never geocoded. "Amanda Lane" is, because a street suffix is
    // a real address signal even without a house number.
    searchAddress: usable && !county && (hasHouseNumber || hasStreetSuffix || hasZip || (hasStateCode && tokens.length > 1)),
  };
}

function matchStrength(candidate, normalizedQuery) {
  const value = normalizeSearchText(candidate);
  if (!value || !normalizedQuery) return 0;
  if (value === normalizedQuery) return 3;
  if (value.startsWith(normalizedQuery)) return 2;
  if (value.includes(normalizedQuery)) return 1;
  // Also treat a per-word prefix ("amanda" vs "amanda whitfield") as a prefix hit.
  return value.split(' ').some((word) => word.startsWith(normalizedQuery)) ? 2 : 0;
}

const TYPE_BASE = { route: 700, record: 600, address: 300, city: 250, county: 200 };

export function scoreResult(result, normalizedQuery) {
  const base = TYPE_BASE[result?.type] || 0;
  const strength = Math.max(
    matchStrength(result?.name, normalizedQuery),
    matchStrength(result?.formatted_address, normalizedQuery),
  );
  const historyBonus = result?.last_interaction_at ? 25 : 0;
  return base + (strength * 100) + historyBonus;
}

export function resultKey(result) {
  if (result?.type === 'record') return `record:${result.address_hash || result.id || result.formatted_address}`;
  if (result?.type === 'route') return `route:${result.route_id || result.id}`;
  if (result?.type === 'county') return `county:${normalizeSearchText(result.name)}`;
  if (result?.type === 'city') return `city:${normalizeSearchText(result.name)}`;
  return `address:${normalizeSearchText(result.formatted_address)}`;
}

/**
 * Stored FirstKnock records outrank external hits, so a searched address that
 * already exists never invites a duplicate lead.
 */
export function rankResults(results, rawQuery, { limit = 12 } = {}) {
  const normalizedQuery = normalizeSearchText(rawQuery);
  const byKey = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!result?.type) continue;
    const key = resultKey(result);
    const scored = { ...result, _score: scoreResult(result, normalizedQuery) };
    const existing = byKey.get(key);
    if (!existing || scored._score > existing._score) byKey.set(key, scored);
  }
  return [...byKey.values()]
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

export function groupResults(results) {
  const groups = [
    { id: 'route', label: 'Routes', items: [] },
    { id: 'record', label: 'Customers & Leads', items: [] },
    { id: 'address', label: 'Addresses', items: [] },
    { id: 'city', label: 'Cities', items: [] },
    { id: 'county', label: 'Counties', items: [] },
  ];
  for (const result of results || []) {
    groups.find((group) => group.id === result.type)?.items.push(result);
  }
  return groups.filter((group) => group.items.length > 0);
}

export function hasUsableCoordinates(result) {
  const lat = Number(result?.lat);
  const lng = Number(result?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);
}