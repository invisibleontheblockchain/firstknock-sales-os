// Geocodio batch geocoder: the paid second source behind the free Census one.
// On the Tampa sample it placed the three new-construction streets that Census
// and OpenStreetMap both missed, using county parcel data.
//
// Geocodio answers *every* query, even nonsense ("nonsense zzz" -> a town in
// Arkansas, a fake house number -> the street centre), so only house-level
// matches are accepted and the state must agree with the one we asked for.

export const GEOCODIO_ENDPOINT = 'https://api.geocod.io/v2/geocode';
export const GEOCODIO_MAX_BATCH = 10000;

// Geocodio accuracy_type values that identify a specific house.
export const HOUSE_LEVEL_ACCURACY = new Set([
  'rooftop', 'point', 'range_interpolation', 'nearest_rooftop_match'
]);
const MIN_ACCURACY = 0.8;

const queryText = (item) => [item.address, item.city, item.state, item.zip]
  .map((part) => String(part ?? '').trim())
  .filter(Boolean)
  .join(', ');

/** Geocodio accepts an object of `{ key: address }` and echoes the keys back. */
export function buildGeocodioPayload(items = []) {
  return Object.fromEntries(items.map((item) => [item.id, queryText(item)]));
}

/**
 * Parse a keyed Geocodio batch response into
 * `{ [id]: { lat, lng, matchedAddress, matchType, accuracy } }`, dropping
 * anything that is not a confident house-level match in the requested state.
 */
export function parseGeocodioResponse(body, items = []) {
  const keyed = body?.results && typeof body.results === 'object' ? body.results : {};
  const stateById = new Map(items.map((item) => [item.id, String(item.state || '').trim().toUpperCase()]));
  const results = {};

  Object.entries(keyed).forEach(([id, entry]) => {
    const best = entry?.response?.results?.[0];
    if (!best) return;
    const lat = Number(best.location?.lat);
    const lng = Number(best.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    if (!HOUSE_LEVEL_ACCURACY.has(best.accuracy_type) || !(Number(best.accuracy) >= MIN_ACCURACY)) return;

    const wantedState = stateById.get(id);
    const gotState = String(best.address_components?.state_province || '').toUpperCase();
    if (wantedState && wantedState.length === 2 && gotState && gotState !== wantedState) return;

    results[id] = {
      lat,
      lng,
      matchedAddress: best.formatted_address || '',
      matchType: best.accuracy_type,
      accuracy: Number(best.accuracy)
    };
  });
  return results;
}

/**
 * Secrets pasted into a dashboard often arrive wrapped in quotes, with a stray
 * space or newline, or with a label/"Bearer" prefix. Geocodio answers any of
 * those with "403 Invalid API key", so strip them rather than fail.
 */
export function normalizeGeocodioKey(raw) {
  const tokens = String(raw ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').split(/\s+/).filter(Boolean);
  return (tokens.at(-1) || '').replace(/^["'`]+|["'`]+$/g, '');
}

export async function geocodeWithGeocodio(items, { apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!Array.isArray(items) || items.length === 0) return {};
  const key = normalizeGeocodioKey(apiKey);
  if (!key) throw new Error('Geocodio API key is not configured.');
  if (items.length > GEOCODIO_MAX_BATCH) throw new Error(`Geocodio batches are limited to ${GEOCODIO_MAX_BATCH} addresses.`);

  const response = await fetchImpl(`${GEOCODIO_ENDPOINT}?limit=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeocodioPayload(items)),
    signal
  });
  if (!response?.ok) {
    // Geocodio explains itself in the body ("Invalid API key"); surface that and
    // the key length (never the key) so a bad secret is diagnosable from logs.
    const detail = await response?.json?.().then((body) => body?.error).catch(() => null);
    throw new Error(`Geocodio returned ${response?.status || 'no response'}${detail ? `: ${detail}` : ''} (key length ${key.length}).`);
  }
  return parseGeocodioResponse(await response.json(), items);
}
