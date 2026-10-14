// Used by place/area search; base and route-anchor lookups use the backend below.
export const NOMINATIM_SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

const LOOKUP_TIMEOUT_MS = 30000;
const LOOKUP_ID = 'location';

function buildAddressQuery(value) {
  const parts = typeof value === 'string' ? [value] : value && typeof value === 'object'
    ? [value.address, value.city, value.state, value.zip] : [];
  return parts.map(part => String(part || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
}

function parseCoordinate(value, minimum, maximum) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

// House geocoders usually omit subunits. Keep the user's apartment/building
// labels while displaying the provider's corrected street, city and ZIP.
function displayAddress(matchedAddress, query) {
  const address = String(matchedAddress || query).trim();
  const unitPattern = /\b(?:apt|apartment|unit|ste|suite|bldg|building|lot|rm|room)\.?\s+#?[\w-]+|#\s*[\w-]+/gi;
  const units = query.match(unitPattern) || [];
  const normalize = text => text.toLowerCase().replace(/[\s.#]+/g, '');
  const matchedUnits = new Set((address.match(unitPattern) || []).map(normalize));
  const missingUnits = units.filter(unit => !matchedUnits.has(normalize(unit)));
  if (!missingUnits.length) return address;
  const comma = address.indexOf(',');
  const streetEnd = comma < 0 ? address.length : comma;
  return `${address.slice(0, streetEnd)}, ${missingUnits.join(', ')}${address.slice(streetEnd)}`;
}

async function invokeBackend(addresses) {
  // Lazy import keeps the lookup testable without a browser or app session.
  const { base44 } = await import('../api/base44Client.js');
  return base44.functions.invoke('geocodeAddressBatch', { addresses });
}

async function lookupWithDeadline(task, signal, timeoutMs) {
  signal?.throwIfAborted();
  let timer;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Address lookup timed out. Please try again.')), timeoutMs);
    if (signal) {
      onAbort = () => reject(signal.reason || new DOMException('Address lookup cancelled.', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([task(), deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Resolve base and route-anchor addresses through the authenticated backend:
 * Census first, then Geocodio for misses/outages. No public map-search request
 * or API key is needed in the browser. `invokeGeocoder` is injectable for tests.
 */
export async function geocodeAddress(value, {
  invokeGeocoder = invokeBackend,
  signal,
  timeoutMs = LOOKUP_TIMEOUT_MS,
} = {}) {
  const query = buildAddressQuery(value);
  if (!query) throw new Error('Enter a street address, city, state, and ZIP first.');
  const item = typeof value === 'object' && value !== null
    ? { id: LOOKUP_ID, address: String(value.address || '').trim(), city: String(value.city || '').trim(),
      state: String(value.state || '').trim(), zip: String(value.zip || '').trim() }
    : { id: LOOKUP_ID, address: query };
  if (!item.address) throw new Error('Enter a street address, city, state, and ZIP first.');

  let response;
  try {
    response = await lookupWithDeadline(() => invokeGeocoder([item]), signal, timeoutMs);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    if (error?.response?.status === 401 || error?.response?.status === 403) {
      throw new Error('Sign in again to look up this address.');
    }
    if (error?.message === 'Address lookup timed out. Please try again.') throw error;
    throw new Error('Address lookup is temporarily unavailable. Please try again.');
  }

  const data = response?.data;
  if (data?.success !== true || !data.results || typeof data.results !== 'object' || Array.isArray(data.results)) {
    throw new Error('The address lookup returned an invalid response. Please try again.');
  }
  const match = data.results[LOOKUP_ID];
  if (!match) {
    throw new Error('We could not find that address. Check the street name, city, state, and ZIP, then try again.');
  }
  const lat = parseCoordinate(match.lat, -90, 90);
  const lng = parseCoordinate(match.lng, -180, 180);
  if (lat === null || lng === null) {
    throw new Error('The address lookup returned invalid coordinates. Please try again.');
  }
  return { address: displayAddress(match.matchedAddress, query), lat, lng };
}
