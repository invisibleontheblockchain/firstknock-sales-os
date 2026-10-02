import { cleanState, geocodeCandidates } from '../../lib/addressListImport.js';

const normalizeHeader = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = value => value == null ? '' : String(value).trim();
const FIELDS = {
  address: ['address', 'fulladdress', 'streetaddress', 'propertyaddress'],
  city: ['city', 'propertycity'], state: ['state', 'stateorprovince', 'propertystate', 'st'],
  zip: ['zip', 'zipcode', 'postalcode', 'ziporpostalcode', 'propertyzip'],
  lat: ['lat', 'latitude'], lng: ['lng', 'lon', 'longitude'],
  house_number: ['housenumber', 'number'], street_name: ['streetname', 'street'],
  address_hash: ['addresshash', 'hash'],
  owner: ['ownerfullname', 'ownername', 'homeownername'],
  husband: ['husbandname'], wife: ['wifename'], last: ['lastname'],
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

// Normalize street suffixes without discarding apartment/unit identifiers.
const STREET_WORDS = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd',
  court: 'ct', lane: 'ln', place: 'pl', terrace: 'ter', circle: 'cir', highway: 'hwy',
  north: 'n', south: 's', east: 'e', west: 'w', apartment: 'unit', apt: 'unit', suite: 'unit', ste: 'unit' };
export function propertyAddressKey(property) {
  const segments = text(property.address || property.full_address).split(',');
  const street = [segments[0], ...segments.slice(1).filter(segment => /^\s*(?:apt\b|apartment\b|unit\b|suite\b|ste\b|#)/i.test(segment))].join(' ');
  const address = street.toLowerCase()
    .replace(/#/g, ' unit ').replace(/\./g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map(word => STREET_WORDS[word] || word).join(' ');
  if (!address) return '';
  const zip = text(property.zip_code || property.zip).slice(0, 5);
  const area = zip || `${text(property.city).toLowerCase()}|${text(property.state).toLowerCase()}`;
  // An address without a locality must not collide with the same street in another city.
  return area.replace(/\|/g, '') ? `${address}|${area}` : '';
}

function makeHash(property) {
  const identity = propertyAddressKey(property)
    || (property.address ? `${text(property.address).toLowerCase()}|${text(property.city).toLowerCase()}|${text(property.state).toLowerCase()}` : `${property.lat}|${property.lng}`);
  let first = 2166136261;
  let second = 2246822507;
  for (let i = 0; i < identity.length; i++) {
    first = Math.imul(first ^ identity.charCodeAt(i), 16777619);
    second = Math.imul(second ^ identity.charCodeAt(i), 3266489909);
  }
  return `import_${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
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

export async function preparePropertyImport(rows, fileName, { geocodeBatch, onProgress = () => {} } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('The file has no data rows.');
  const headers = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  if (!hasPropertyColumns(headers)) throw new Error('No address columns found. Include Address and ZIP, or Address, City and State.');
  const mapping = buildPropertyColumnMapping(headers);
  const read = (row, field) => mapping[field] ? row[mapping[field]] : null;
  const candidates = new Map();
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
    property.address_hash = text(read(row, 'address_hash')) || makeHash(property);
    const key = propertyAddressKey(property) || property.address_hash;
    if (candidates.has(key)) {
      duplicatesRemoved++;
      // Keep a row that already has usable coordinates to avoid an unnecessary lookup.
      const existing = candidates.get(key).property;
      if ((!validCoordinates(existing) && validCoordinates(property))
        || (validCoordinates(existing) === validCoordinates(property) && (property.sale_date || '') > (existing.sale_date || ''))) candidates.set(key, { property, source });
    } else candidates.set(key, { property, source });
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
  const knownAddresses = new Set(existingProperties.map(propertyAddressKey).filter(Boolean));
  const additions = [];
  let duplicatesRemoved = 0;
  for (const property of importedProperties) {
    const key = propertyAddressKey(property);
    const aliases = [property.address_hash, property.legacy_hash, property.id].filter(Boolean).map(String);
    if (aliases.some(hash => knownHashes.has(hash)) || (key && knownAddresses.has(key))) {
      duplicatesRemoved++;
      continue;
    }
    additions.push(property);
    knownHashes.add(String(property.address_hash));
    if (key) knownAddresses.add(key);
  }
  return { additions, duplicatesRemoved, propertyHashes: [...hashes, ...additions.map(property => property.address_hash)] };
}

export async function geocodePropertyImportBatch(addresses, deps) {
  const candidates = addresses.map((query, index) => ({ id: String(index), query }));
  const { resolved, batchFailed } = await geocodeCandidates(candidates, deps);
  if (batchFailed && !resolved.size) throw new Error('Address lookup is unavailable. Please retry.');
  return candidates.map(candidate => resolved.get(candidate.id) || { reason: 'Address could not be located' });
}
