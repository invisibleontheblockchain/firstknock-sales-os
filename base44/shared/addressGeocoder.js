// Server-side geocoding waterfall: free Census first, then Geocodio for
// whatever Census missed (or for everything if Census is down).

import { CENSUS_MAX_BATCH, geocodeWithCensus } from './censusGeocode.js';
import { geocodeWithGeocodio } from './geocodioGeocode.js';

export const GEOCODE_BATCH_LIMIT = CENSUS_MAX_BATCH;

/**
 * @param {Array<{ id: string, address: string, city?: string, state?: string, zip?: string }>} items
 * @param {{ geocodioApiKey?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ results: Record<string, object>, counts: { census: number, geocodio: number }, warnings: string[] }>}
 * Each result carries `source`. Throws only when every configured source failed
 * and nothing was resolved, so the caller can fall back to its own lookup.
 */
export async function geocodeAddressItems(items, { geocodioApiKey, fetchImpl = globalThis.fetch } = {}) {
  const results = {};
  const warnings = [];
  const failures = [];

  try {
    const census = await geocodeWithCensus(items, { fetchImpl });
    Object.entries(census).forEach(([id, hit]) => { results[id] = { ...hit, source: 'census' }; });
  } catch (error) {
    failures.push(error);
    warnings.push(`census: ${error?.message || error}`);
  }

  const missed = items.filter((item) => !results[item.id]);
  if (missed.length > 0 && geocodioApiKey) {
    try {
      const geocodio = await geocodeWithGeocodio(missed, { apiKey: geocodioApiKey, fetchImpl });
      Object.entries(geocodio).forEach(([id, hit]) => { results[id] = { ...hit, source: 'geocodio' }; });
    } catch (error) {
      failures.push(error);
      warnings.push(`geocodio: ${error?.message || error}`);
    }
  } else if (missed.length > 0) {
    warnings.push('geocodio: not configured (set GEOCODIO_API_KEY)');
  }

  if (Object.keys(results).length === 0 && failures.length > 0) {
    throw new Error(warnings.join('; '));
  }

  const counts = { census: 0, geocodio: 0 };
  Object.values(results).forEach((hit) => { counts[hit.source] += 1; });
  return { results, counts, warnings };
}
