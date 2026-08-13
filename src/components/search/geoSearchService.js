// External geographic lookup for the unified search.
// Reuses the app's existing provider (OpenStreetMap/Nominatim, no credentials
// in the client bundle) and constrains results to the United States.

import { NOMINATIM_SEARCH_ENDPOINT } from '@/lib/geocoding';

function parseBounds(boundingbox) {
  if (!Array.isArray(boundingbox) || boundingbox.length !== 4) return null;
  const [south, north, west, east] = boundingbox.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return [[south, west], [north, east]];
}

async function queryNominatim(query, { fetchImpl = globalThis.fetch, endpoint = NOMINATIM_SEARCH_ENDPOINT, signal, limit = 5, featureType } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Address lookup is unavailable on this device.');
  const url = new URL(endpoint);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('q', query);
  if (featureType) url.searchParams.set('featureType', featureType);

  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response?.ok) throw new Error('Address lookup is temporarily unavailable.');
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

export async function searchExternalAddresses(query, options = {}) {
  const rows = await queryNominatim(query, options);
  return rows
    .map((row) => {
      const address = row.address || {};
      const lat = Number(row.lat);
      const lng = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const street = [address.house_number, address.road].filter(Boolean).join(' ');
      return {
        type: 'address',
        source: 'external',
        name: street || row.name || row.display_name,
        formatted_address: row.display_name,
        street: street || null,
        city: address.city || address.town || address.village || address.hamlet || null,
        state: address.state_code || address.state || null,
        zip: address.postcode || null,
        county: address.county || null,
        lat,
        lng,
      };
    })
    .filter(Boolean);
}

export async function searchCities(query, options = {}) {
  // featureType=city keeps the provider from returning streets or POIs, so a
  // city hit is always a place the camera can frame by its bounding box.
  const rows = await queryNominatim(query, { ...options, limit: 5, featureType: 'city' });
  return rows
    .map((row) => {
      const lat = Number(row.lat);
      const lng = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const address = row.address || {};
      const city = address.city || address.town || address.village || row.name;
      const state = address.state || '';
      if (!city) return null;
      return {
        type: 'city',
        source: 'external',
        // State is always shown so Charlotte NC and Charlotte MI stay distinct.
        name: [city, state].filter(Boolean).join(', '),
        formatted_address: row.display_name,
        lat,
        lng,
        bounds: parseBounds(row.boundingbox),
      };
    })
    .filter(Boolean);
}

export async function searchCounties(query, options = {}) {
  const rows = await queryNominatim(query, { ...options, limit: 5 });
  return rows
    .filter((row) => /county|administrative/i.test(`${row.type} ${row.addresstype || ''}`) || /county/i.test(row.display_name))
    .map((row) => {
      const lat = Number(row.lat);
      const lng = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const address = row.address || {};
      const county = address.county || row.name;
      const state = address.state || '';
      return {
        type: 'county',
        source: 'external',
        // The state is always shown so same-named counties stay distinguishable.
        name: [county, state].filter(Boolean).join(', '),
        formatted_address: row.display_name,
        lat,
        lng,
        bounds: parseBounds(row.boundingbox),
      };
    })
    .filter(Boolean);
}