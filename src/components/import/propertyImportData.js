import { cleanState, geocodeCandidates } from '../../lib/addressListImport.js';
import { canonicalStreetLine, normalizeName } from '../../../base44/shared/addressNormalize.js';

const normalizeHeader = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = value => value == null ? '' : String(value).trim();
const FIELDS = {
  address: ['address', 'fulladdress', 'streetaddress', 'propertyaddress', 'address1', 'siteaddress'],
  city: ['city', 'propertycity', 'town'], state: ['state', 'stateorprovince', 'propertystate', 'st'],
  zip: ['zip', 'zipcode', 'postalcode', 'ziporpostalcode', 'propertyzip', 'zip5'],
  lat: ['lat', 'latitude'], lng: ['lng', 'lon', 'longitude', 'long'],
  house_number: ['housenumber', 'number'], street_name: ['streetname', 'street'],
  address_hash: ['addresshash', 'hash'],
  owner: ['ownerfullname', 'ownername', 'homeownername', 'owner', 'fullname', 'name', 'homeowner', 'contactname'],
  husband: ['husbandname', 'firstname', 'ownerfirstname'], wife: ['wifename', 'spousename'], last: ['lastname', 'surname', 'ownerlastname'],
  county: ['county', 'countyname'],
  status: ['originalstatus', 'status'], beds: ['beds', 'bedrooms'], baths: ['baths', 'bathrooms'],
  sqft: ['sqft', 'squarefeet'], year_built: ['yearbuilt'], price: ['price', 'saleprice'],
  sale_date: ['solddate', 'saledate', 'lastsolddate'],
  sale_type: ['saletype'], property_type: ['propertytype'], mls_id: ['mls', 'mlsid'], url: ['url'],
};

export function buildPropertyColumnMapping(headers) {
  return Object.fromEntries(Object.entries(FIELDS).map(([field, aliases]) => [
    field, aliases.map(alias => headers.find(header => normalizeHeader(header) === alias)).find(Boolean) || null,
  ]));
}

export function hasPropertyColumns(headers) {
  const mapping = buildPropertyColumnMapping(headers);
  return !!(mapping.address || (mapping.house_number && mapping.street_name) || (mapping.lat && mapping.lng));
}

export function validCoordinates(property) {
  const { lat, lng } = property || {};
  return lat != null && lng != null && lat !== '' && lng !== ''
    && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180
    && !(Number(lat) === 0 && Number(lng) === 0);
}

// The street line a record was imported with. Provider records sometimes carry
// only the parsed parts, so those are joined back rather than treated as blank.
function importedStreetLine(property) {
  const raw = text(property.address || property.full_address);
  if (raw) return raw;
  const houseNumber = Number(property.house_number);
  const streetName = text(property.street_name);
  if (Number.isFinite(houseNumber) && houseNumber > 0 && streetName && !/^unknown street$/i.test(streetName)) {
    return `${houseNumber} ${streetName}`;
  }
  return '';
}

/**
 * The keys under which this record counts as the same door: the canonical
 * street line (shared USPS normalization, so "Water Street", "Water St" and
 * "WATER STR" agree) with the ZIP, and with the city and state.
 */
export function addressKeyParts(property) {
  const raw = importedStreetLine(property || {});
  if (!raw) return { zipKey: '', areaKey: '' };
  const city = text(property.city);
  const state = text(property.state);
  const { line, zip } = canonicalStreetLine(raw, { city, state, zip: property.zip_code || property.zip });
  if (!line) return { zipKey: '', areaKey: '' };
  const area = normalizeName(city) && normalizeName(state) ? `${normalizeName(city)}|${normalizeName(state)}` : '';
  // An address without a locality must not collide with the same street in another city.
  return { zipKey: zip ? `${line}|${zip}` : '', areaKey: area ? `${line}|${area}` : '' };
}

export function propertyAddressKey(property) {
  const { zipKey, areaKey } = addressKeyParts(property);
  return zipKey || areaKey || '';
}

/**
 * Same-door lookup across records that describe the locality differently.
 * When both records carry a ZIP the ZIP decides, so the same street number in
 * two ZIPs stays two houses. A record without a ZIP (a file with only City and
 * State columns) matches on street + city + state instead, in either direction.
 */
export function createAddressIndex() {
  const byZipKey = new Map();
  const byAreaKeyWithZip = new Map();
  const byAreaKeyNoZip = new Map();
  return {
    find(property) {
      const { zipKey, areaKey } = addressKeyParts(property);
      if (zipKey) {
        if (byZipKey.has(zipKey)) return byZipKey.get(zipKey);
        return areaKey ? byAreaKeyNoZip.get(areaKey) : undefined;
      }
      if (!areaKey) return undefined;
      return byAreaKeyWithZip.has(areaKey) ? byAreaKeyWithZip.get(areaKey) : byAreaKeyNoZip.get(areaKey);
    },
    add(property, value = true) {
      const { zipKey, areaKey } = addressKeyParts(property);
      if (zipKey) {
        byZipKey.set(zipKey, value);
        if (areaKey) byAreaKeyWithZip.set(areaKey, value);
      } else if (areaKey) {
        byAreaKeyNoZip.set(areaKey, value);
      }
      return Boolean(zipKey || areaKey);
    },
  };
}

export function sameImportedAddress(a, b) {
  const index = createAddressIndex();
  return index.add(a) && index.find(b) === true;
}

// The key imports used before the shared normalization, frozen exactly as it
// was. Records already saved carry hashes built from it, so a re-import also
// computes this hash (as legacy_hash) and reuses those records instead of
// creating a second copy of the same house.
const LEGACY_STREET_WORDS = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd',
  court: 'ct', lane: 'ln', place: 'pl', terrace: 'ter', circle: 'cir', highway: 'hwy',
  north: 'n', south: 's', east: 'e', west: 'w', apartment: 'unit', apt: 'unit', suite: 'unit', ste: 'unit' };
export function legacyPropertyAddressKey(property) {
  const segments = text(property.address || property.full_address).split(',');
  const street = [segments[0], ...segments.slice(1).filter(segment => /^\s*(?:apt\b|apartment\b|unit\b|suite\b|ste\b|#)/i.test(segment))].join(' ');
  const address = street.toLowerCase()
    .replace(/#/g, ' unit ').replace(/\./g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map(word => LEGACY_STREET_WORDS[word] || word).join(' ');
  if (!address) return '';
  const zip = text(property.zip_code || property.zip).slice(0, 5);
  const area = zip || `${text(property.city).toLowerCase()}|${text(property.state).toLowerCase()}`;
  return area.replace(/\|/g, '') ? `${address}|${area}` : '';
}

function hashIdentity(property, key) {
  const identity = key
    || (property.address ? `${text(property.address).toLowerCase()}|${text(property.city).toLowerCase()}|${text(property.state).toLowerCase()}` : `${property.lat}|${property.lng}`);
  let first = 2166136261;
  let second = 2246822507;
  for (let i = 0; i < identity.length; i++) {
    first = Math.imul(first ^ identity.charCodeAt(i), 16777619);
    second = Math.imul(second ^ identity.charCodeAt(i), 3266489909);
  }
  return `import_${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function makeHash(property) {
  return hashIdentity(property, propertyAddressKey(property));
}

export function legacyImportHash(property) {
  return hashIdentity(property, legacyPropertyAddressKey(property));
}

/** Hashes under which an imported record may already exist. */
export function importHashAliases(property) {
  return [...new Set([property?.address_hash, property?.legacy_hash].map(value => text(value)).filter(Boolean))];
}

function number(value) {
  if (!text(value)) return null;
  const parsed = Number(text(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function saleDate(value) {
  if (!text(value)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

// Of two rows for one door, keep the one that already has usable coordinates
// (no lookup needed), then the one that names its ZIP, then the newer sale.
function betterDuplicate(next, current) {
  if (validCoordinates(next) !== validCoordinates(current)) return validCoordinates(next);
  if (Boolean(text(next.zip_code)) !== Boolean(text(current.zip_code))) return Boolean(text(next.zip_code));
  return (next.sale_date || '') > (current.sale_date || '');
}

export async function preparePropertyImport(rows, fileName, { geocodeBatch, onProgress = () => {} } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('The file has no data rows.');
  const headers = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  if (!hasPropertyColumns(headers)) throw new Error('No address columns found. Include Address and ZIP, or Address, City and State.');
  const mapping = buildPropertyColumnMapping(headers);
  const read = (row, field) => mapping[field] ? row[mapping[field]] : null;
  const candidates = new Map();
  // Which kept row a later row is the same door as, however its locality is written.
  const addressIndex = createAddressIndex();
  const skippedRows = [];
  let duplicatesRemoved = 0;
  rows.forEach((row, index) => {
    const address = text(read(row, 'address')) || [read(row, 'house_number'), read(row, 'street_name')].filter(Boolean).join(' ');
    const property = {
      address, full_address: address,
      city: text(read(row, 'city')), state: cleanState(read(row, 'state')),
      zip_code: text(read(row, 'zip')).replace(/\.0$/, '').padStart(text(read(row, 'zip')) ? 5 : 0, '0'),
      lat: number(read(row, 'lat')), lng: number(read(row, 'lng')),
      owner_full_name: text(read(row, 'owner')) || [
        [text(read(row, 'husband')), text(read(row, 'wife'))].filter(Boolean).join(' & '), text(read(row, 'last')),
      ].filter(Boolean).join(' '),
      house_number: Number.parseInt(address, 10) || 0,
      street_name: address.replace(/^\d+\s*/, '') || 'Unknown Street',
      original_status: /sold/i.test(text(read(row, 'status'))) ? 'SOLD'
        : ['HARD_NO', 'DO_NOT_KNOCK', 'UNVERIFIED'].includes(text(read(row, 'status')).toUpperCase()) ? text(read(row, 'status')).toUpperCase() : 'ELIGIBLE',
      status: text(read(row, 'status')), data_source: 'csv_import',
      raw_metadata: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])),
    };
    const county = text(read(row, 'county')).replace(/\s+county$/i, '');
    if (county) property.raw_metadata.county = county;
    for (const field of ['beds', 'baths', 'sqft', 'year_built', 'price']) {
      const parsed = number(read(row, field));
      if (parsed !== null) property[field] = field === 'year_built' ? Math.trunc(parsed) : parsed;
    }
    const sold = saleDate(read(row, 'sale_date'));
    if (sold) { property.sale_date = sold; property.sold_date = sold; }
    for (const field of ['sale_type', 'property_type', 'mls_id', 'url']) {
      if (text(read(row, field))) property[field] = text(read(row, field));
    }
    if (property.price != null) property.sale_price = property.price;
    const source = { row: index + 2, address: [address, property.city, property.state, property.zip_code].filter(Boolean).join(', ') };
    if (!address && !validCoordinates(property)) {
      skippedRows.push({ ...source, reason: 'Missing address and coordinates' });
      return;
    }
    const fileHash = text(read(row, 'address_hash'));
    property.address_hash = fileHash || makeHash(property);
    if (!fileHash) {
      const legacyHash = legacyImportHash(property);
      if (legacyHash !== property.address_hash) property.legacy_hash = legacyHash;
    }
    const key = addressIndex.find(property) || propertyAddressKey(property) || property.address_hash;
    if (candidates.has(key)) {
      duplicatesRemoved++;
      if (betterDuplicate(property, candidates.get(key).property)) candidates.set(key, { property, source });
    } else candidates.set(key, { property, source });
    addressIndex.add(property, key);
  });

  const missing = [...candidates.values()].filter(({ property }) => !validCoordinates(property));
  if (missing.length && typeof geocodeBatch !== 'function') throw new Error('Address lookup is unavailable. Try again or include latitude and longitude.');
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    onProgress(`Locating addresses ${i + 1}–${Math.min(i + 100, missing.length)} of ${missing.length}...`);
    const results = await geocodeBatch(batch.map(({ property }) => ({
      address: property.address, city: property.city, state: property.state, zip: property.zip_code,
    })));
    if (!Array.isArray(results) || results.length !== batch.length) throw new Error('Address lookup returned an incomplete response. Please retry.');
    batch.forEach(({ property, source }, index) => {
      const result = results[index];
      if (validCoordinates(result)) {
        property.lat = Number(result.lat); property.lng = Number(result.lng);
        property.raw_metadata.geocoding_source = result.source || 'census';
      } else skippedRows.push({ ...source, reason: result?.reason || 'Address could not be located' });
    });
  }
  const properties = [...candidates.values()].map(item => item.property).filter(validCoordinates);
  if (!properties.length) throw new Error(`No properties could be located. Check the addresses, city, state and ZIP in ${fileName}.`);
  return {
    fileName, routeName: text(fileName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') || 'Imported Route',
    properties, skippedRows,
    summary: { ready: properties.length, skipped: skippedRows.length, duplicatesRemoved },
  };
}

export function mergeImportedStops(route, existingProperties, importedProperties) {
  const hashes = [...(route.property_hashes || [])];
  const knownHashes = new Set(hashes.map(String));
  existingProperties.forEach(property => [property.address_hash, property.legacy_hash, property.id]
    .filter(Boolean).forEach(hash => knownHashes.add(String(hash))));
  const knownAddresses = createAddressIndex();
  existingProperties.forEach(property => knownAddresses.add(property));
  const additions = [];
  let duplicatesRemoved = 0;
  for (const property of importedProperties) {
    const aliases = [property.address_hash, property.legacy_hash, property.id].filter(Boolean).map(String);
    if (aliases.some(hash => knownHashes.has(hash)) || knownAddresses.find(property)) {
      duplicatesRemoved++;
      continue;
    }
    additions.push(property);
    knownHashes.add(String(property.address_hash));
    knownAddresses.add(property);
  }
  return { additions, duplicatesRemoved, propertyHashes: [...hashes, ...additions.map(property => property.address_hash)] };
}

/**
 * Imported stops that are already on another active route of the account, so
 * a second file for the same neighborhood does not send two reps to one door.
 * Matching is by stored hash (current or legacy import scheme); routes that are
 * finished or archived, and the destination route itself, are not counted.
 */
export function findImportedStopsOnOtherRoutes(importedProperties = [], routes = [], { excludeRouteId = null } = {}) {
  const hashes = new Set();
  const matchedRoutes = [];
  for (const route of routes || []) {
    if (!route || (excludeRouteId && String(route.id) === String(excludeRouteId))) continue;
    if (['COMPLETED', 'ARCHIVED'].includes(String(route.status || '').toUpperCase())) continue;
    const routeHashes = new Set((route.property_hashes || []).map(String));
    if (!routeHashes.size) continue;
    let count = 0;
    for (const property of importedProperties || []) {
      if (importHashAliases(property).some(hash => routeHashes.has(hash))) {
        hashes.add(text(property.address_hash));
        count++;
      }
    }
    if (count) matchedRoutes.push({ id: route.id, name: route.name || 'Unnamed route', count });
  }
  return { hashes, count: hashes.size, routes: matchedRoutes };
}

export async function geocodePropertyImportBatch(addresses, deps) {
  const candidates = addresses.map((query, index) => ({ id: String(index), query }));
  const { resolved, batchFailed } = await geocodeCandidates(candidates, deps);
  if (batchFailed && !resolved.size) throw new Error('Address lookup is unavailable. Please retry.');
  return candidates.map(candidate => resolved.get(candidate.id) || { reason: 'Address could not be located' });
}
