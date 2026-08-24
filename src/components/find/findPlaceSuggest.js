import { NOMINATIM_SEARCH_ENDPOINT } from '@/lib/geocoding';

// Place types Nominatim uses for populated places. The public /find search is a
// city finder, so only these are offered as suggestions.
const CITY_CLASSES = new Set(['city', 'town', 'village', 'municipality', 'hamlet', 'suburb']);

function toSuggestion(result) {
  const lat = Number(result?.lat);
  const lng = Number(result?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const parts = String(result?.display_name || '').split(',').map((p) => p.trim()).filter(Boolean);
  const label = parts[0] || String(result?.name || '').trim();
  if (!label) return null;

  return {
    id: String(result?.place_id ?? `${lat},${lng}`),
    label,
    sublabel: parts.slice(1, 3).join(', '),
    lat,
    lng,
  };
}

/**
 * Suggest US cities for a partial query. `fetchImpl` and `endpoint` are
 * injectable so the lookup can be exercised without a network request.
 */
export async function suggestCities(query, {
  fetchImpl = globalThis.fetch,
  endpoint = NOMINATIM_SEARCH_ENDPOINT,
  signal,
} = {}) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 3 || typeof fetchImpl !== 'function') return [];

  const url = new URL(endpoint);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('q', trimmed);

  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response?.ok) return [];

  const results = await response.json();
  if (!Array.isArray(results)) return [];

  const cities = results.filter((r) => CITY_CLASSES.has(String(r?.addresstype || r?.type || '')));
  return (cities.length ? cities : results).map(toSuggestion).filter(Boolean).slice(0, 5);
}