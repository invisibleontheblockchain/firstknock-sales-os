export const NOMINATIM_SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

function buildAddressQuery(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';

  return [value.address, value.city, value.state, value.zip]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

function parseCoordinate(value, minimum, maximum) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

/**
 * Resolve an address through Nominatim.
 *
 * `fetchImpl` and `endpoint` are injectable so callers can test the lookup
 * without making a network request.
 */
export async function geocodeAddress(value, {
  fetchImpl = globalThis.fetch,
  endpoint = NOMINATIM_SEARCH_ENDPOINT,
  signal
} = {}) {
  const query = buildAddressQuery(value);
  if (!query) throw new Error('Enter a Home Base address first.');
  if (typeof fetchImpl !== 'function') throw new Error('Address lookup is unavailable on this device.');

  const url = new URL(endpoint);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('q', query);

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Could not reach the address lookup service. Check your connection and try again.');
  }

  if (!response?.ok) {
    throw new Error('Address lookup is temporarily unavailable. Please try again.');
  }

  let results;
  try {
    results = await response.json();
  } catch {
    throw new Error('The address lookup returned an invalid response. Please try again.');
  }

  const match = Array.isArray(results) ? results[0] : null;
  const lat = parseCoordinate(match?.lat, -90, 90);
  const lng = parseCoordinate(match?.lon ?? match?.lng, -180, 180);
  if (lat === null || lng === null) {
    throw new Error('We could not find that address. Add the city, state, and ZIP, then try again.');
  }

  return {
    address: String(match?.display_name || query).trim(),
    lat,
    lng
  };
}
