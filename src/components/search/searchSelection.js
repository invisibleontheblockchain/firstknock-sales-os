import { hasUsableCoordinates } from './searchQuery.js';

/**
 * Turn an internal search result into the property shape the canonical property
 * card already renders. An already-loaded property always wins so the card keeps
 * every field the map pipeline computed for it (status, sale data, route).
 */
export function resolveSelectedProperty(result, loadedProperties = []) {
  const aliases = [result?.address_hash, result?.legacy_hash, result?.id].filter(Boolean).map(String);
  const existing = aliases.length
    ? loadedProperties.find((property) => (
      aliases.includes(String(property?.address_hash))
      || aliases.includes(String(property?.legacy_hash))
      || aliases.includes(String(property?.id))
    ))
    : null;

  if (existing) return { property: existing, locatable: hasUsableCoordinates(existing) };
  if (!hasUsableCoordinates(result)) {
    return {
      property: {
        id: result?.id || result?.address_hash || 'search-result',
        address_hash: result?.address_hash || result?.id || null,
        full_address: result?.formatted_address || result?.name || '',
        street_name: result?.street || result?.formatted_address || '',
        house_number: '',
        effective_status: result?.status || 'ELIGIBLE',
        owner_full_name: result?.name || null,
      },
      locatable: false,
    };
  }

  return {
    property: {
      id: result.id || result.address_hash,
      address_hash: result.address_hash || result.id,
      legacy_hash: result.legacy_hash || null,
      full_address: result.formatted_address || result.street || '',
      street_name: result.street || result.formatted_address || '',
      house_number: '',
      city: result.city || null,
      state: result.state || null,
      zip_code: result.zip || null,
      lat: Number(result.lat),
      lng: Number(result.lng),
      owner_full_name: result.name || null,
      effective_status: result.status || 'ELIGIBLE',
    },
    locatable: true,
  };
}

/**
 * Explicit map commands. A user-selected result is the authoritative viewport
 * action, so callers mark the initial working-area fit as already applied.
 */
export function focusMapPoint(mapRef, point, zoom = 18) {
  const map = mapRef?.current;
  if (!map || !map._mapPane || !hasUsableCoordinates(point)) return false;
  try {
    map.setView([Number(point.lat), Number(point.lng)], zoom, { animate: true });
    return true;
  } catch {
    return false;
  }
}

export function fitMapBounds(mapRef, bounds, { padding = [40, 40], maxZoom = 13 } = {}) {
  const map = mapRef?.current;
  if (!map || !map._mapPane || !Array.isArray(bounds) || bounds.length !== 2) return false;
  try {
    map.fitBounds(bounds, { padding, maxZoom, animate: true });
    return true;
  } catch {
    return false;
  }
}