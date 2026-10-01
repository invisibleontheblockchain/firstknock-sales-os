// Turns a plain address list (CSV or Excel rows with Address / City / State /
// Zip and no coordinates) into properties ready to route: it cleans and
// de-duplicates the addresses, geocodes them, and tags each one with the owner
// and county columns from the sheet.
//
// Kept free of Base44/React imports so the whole pipeline runs under node:test.

import { addressDedupeKey, normalizeZip, parseHouseNumber } from '../../base44/shared/addressNormalize.js';

const COLUMN_ALIASES = {
  address: ['address', 'streetaddress', 'address1', 'propertyaddress', 'siteaddress', 'fulladdress'],
  city: ['city', 'town', 'propertycity'],
  state: ['state', 'st', 'stateorprovince', 'propertystate'],
  zip: ['zip', 'zipcode', 'zip5', 'postalcode', 'ziporpostalcode', 'propertyzip'],
  county: ['county', 'countyname'],
  lat: ['lat', 'latitude'],
  lng: ['lng', 'lon', 'long', 'longitude'],
  ownerName: ['ownername', 'owner', 'fullname', 'name', 'homeowner', 'contactname'],
  firstNames: ['husbandname', 'wifename', 'spousename', 'firstname', 'ownerfirstname'],
  lastName: ['lastname', 'surname', 'ownerlastname']
};

const STATE_ABBREVIATIONS = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY', northcarolina: 'NC', northdakota: 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', rhodeisland: 'RI', southcarolina: 'SC',
  southdakota: 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY', districtofcolumbia: 'DC'
};

const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const UNIT_SUFFIX = /[\s,]*(?:#|\b(?:apt|apartment|unit|ste|suite|bldg|building|lot|rm|room)\b\.?)\s*[\w-]+\s*$/i;

export const GEOCODE_BATCH_SIZE = 250;
export const MAX_FALLBACK_LOOKUPS = 150;
const FALLBACK_DELAY_MS = 1100; // Nominatim allows one request per second.

const normalizeHeader = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';
const text = (value) => (isBlank(value) ? '' : String(value).replace(/\s+/g, ' ').trim());

function getHeaders(rows = []) {
  const set = new Set();
  rows.forEach((row) => Object.keys(row || {}).forEach((key) => set.add(key)));
  return Array.from(set);
}

function findColumns(headers, aliases) {
  return aliases
    .map((alias) => headers.find((header) => normalizeHeader(header) === alias))
    .filter(Boolean);
}

export function detectAddressColumns(rows = []) {
  const headers = getHeaders(rows);
  const first = (key) => findColumns(headers, COLUMN_ALIASES[key])[0] || null;
  return {
    headers,
    address: first('address'),
    city: first('city'),
    state: first('state'),
    zip: first('zip'),
    county: first('county'),
    lat: first('lat'),
    lng: first('lng'),
    ownerName: first('ownerName'),
    // A sheet can carry several first-name columns (husband and wife).
    firstNames: COLUMN_ALIASES.firstNames
      .map((alias) => headers.find((header) => normalizeHeader(header) === alias))
      .filter(Boolean),
    lastName: first('lastName')
  };
}

export function parseCoordinate(value, limit) {
  if (isBlank(value)) return null;
  const number = Number(String(value).trim());
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function rowCoordinates(row, columns) {
  if (!columns.lat || !columns.lng) return null;
  const lat = parseCoordinate(row[columns.lat], 90);
  const lng = parseCoordinate(row[columns.lng], 180);
  if (lat === null || lng === null) return null;
  return Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001 ? null : { lat, lng };
}

/**
 * True when the rows look like an address list we can geocode: an address
 * column plus enough locality (zip, or city and state) to resolve it, and at
 * least one row still needs coordinates.
 */
export function isAddressListData(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const columns = detectAddressColumns(rows);
  if (!columns.address) return false;
  if (!columns.zip && !(columns.city && columns.state)) return false;
  return rows.some((row) => !isBlank(row[columns.address]) && !rowCoordinates(row, columns));
}

export function cleanZip(value) {
  if (isBlank(value)) return '';
  const raw = String(value).trim().replace(/\.0$/, '');
  // Excel stores 02134 as the number 2134, so restore the leading zero.
  if (/^\d{3,4}$/.test(raw)) return raw.padStart(5, '0');
  return normalizeZip(raw);
}

export function cleanState(value) {
  const raw = text(value).replace(/\./g, '');
  if (!raw) return '';
  if (raw.length === 2) return raw.toUpperCase();
  return STATE_ABBREVIATIONS[normalizeHeader(raw)] || raw;
}

function titleCaseWord(word) {
  const lower = word.toLowerCase();
  if (DIRECTIONALS.has(lower.replace(/\./g, ''))) return word.toUpperCase();
  if (/\d/.test(word)) return /^#/.test(word) ? word.toUpperCase() : lower; // 53RD -> 53rd, #12B stays
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Only re-case text that is entirely upper case, so "McDonald Rd" is left alone.
export function tidyCase(value) {
  const clean = text(value);
  if (!clean || clean !== clean.toUpperCase()) return clean;
  return clean.split(' ').map(titleCaseWord).join(' ');
}

export function splitStreetAndUnit(value) {
  const clean = text(value).replace(/\.(?=\s|,|$)/g, '');
  const match = clean.match(UNIT_SUFFIX);
  if (!match || match.index === 0) return { street: clean, unit: '' };
  return { street: clean.slice(0, match.index).trim(), unit: match[0].replace(/^[\s,]+/, '').trim() };
}

function composeOwnerName(row, columns) {
  const direct = columns.ownerName ? text(row[columns.ownerName]) : '';
  const last = columns.lastName ? text(row[columns.lastName]) : '';
  const firsts = columns.firstNames.map((column) => text(row[column])).filter(Boolean);
  if (firsts.length || last) return [firsts.join(' & '), last].filter(Boolean).join(' ');
  return direct;
}

// "Hills" and "Hillsborough" in one file are the same county: expand a county
// that is a prefix of a longer one found elsewhere in the file.
function buildCountyResolver(values) {
  const known = Array.from(new Set(values.map((value) => tidyCase(text(value).replace(/\s+county$/i, ''))).filter(Boolean)));
  return (value) => {
    const county = tidyCase(text(value).replace(/\s+county$/i, ''));
    if (!county) return '';
    const longer = known
      .filter((other) => other.length > county.length && other.toLowerCase().startsWith(county.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    return longer || county;
  };
}

function hashString(input) {
  let hash = 0;
  const value = String(input || '');
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function listNameFromFile(fileName) {
  return String(fileName || 'Imported List')
    .replace(/\.(xlsx|xls|csv|json)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Imported List';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve coordinates for candidates that lack them.
 *
 * `geocodeBatch(items)` -> `{ [id]: { lat, lng } }` is the fast bulk lookup
 * (Census, via the backend). Whatever it misses, or all of it if the backend
 * call fails, goes through `geocodeOne(query)` -> `{ lat, lng }` one at a time,
 * capped so a huge file cannot hold the page for minutes.
 */
export async function geocodeCandidates(candidates, {
  geocodeBatch,
  geocodeOne,
  onProgress,
  batchSize = GEOCODE_BATCH_SIZE,
  maxFallback = MAX_FALLBACK_LOOKUPS,
  delayMs = FALLBACK_DELAY_MS,
  wait = sleep
} = {}) {
  const resolved = new Map();
  const pending = candidates.filter((candidate) => !candidate.coords);
  const report = (phase, done, total) => onProgress?.({ phase, done, total });
  let batchFailed = false;

  if (typeof geocodeBatch === 'function') {
    for (let start = 0; start < pending.length; start += batchSize) {
      const chunk = pending.slice(start, start + batchSize);
      report('batch', start, pending.length);
      try {
        const results = await geocodeBatch(chunk.map((c) => ({ id: c.id, ...c.query })));
        chunk.forEach((c) => {
          const hit = results?.[c.id];
          const lat = parseCoordinate(hit?.lat, 90);
          const lng = parseCoordinate(hit?.lng, 180);
          if (lat !== null && lng !== null) resolved.set(c.id, { lat, lng, source: hit.source || 'census', matchType: hit.matchType || '' });
        });
      } catch (error) {
        batchFailed = true;
        console.warn('[addressListImport] Batch geocoding failed, falling back to single lookups:', error?.message || error);
      }
    }
    report('batch', pending.length, pending.length);
  }

  const leftovers = pending.filter((c) => !resolved.has(c.id));
  if (typeof geocodeOne === 'function' && leftovers.length > 0) {
    const attempts = leftovers.slice(0, maxFallback);
    for (let i = 0; i < attempts.length; i += 1) {
      report('fallback', i, attempts.length);
      try {
        const hit = await geocodeOne(attempts[i].query);
        const lat = parseCoordinate(hit?.lat, 90);
        const lng = parseCoordinate(hit?.lng, 180);
        if (lat !== null && lng !== null) resolved.set(attempts[i].id, { lat, lng, source: 'nominatim', matchType: '' });
      } catch {
        // A single unresolvable address must not abort the import.
      }
      if (i < attempts.length - 1) await wait(delayMs);
    }
    report('fallback', attempts.length, attempts.length);
  }

  return { resolved, batchFailed, fallbackSkipped: Math.max(0, leftovers.length - maxFallback) };
}

export async function prepareAddressListImport(rows, fileName = 'Imported List.xlsx', deps = {}) {
  if (!isAddressListData(rows)) return null;

  const columns = detectAddressColumns(rows);
  const listName = listNameFromFile(fileName);
  const resolveCounty = buildCountyResolver(columns.county ? rows.map((row) => row[columns.county]) : []);
  const mappedHeaders = new Set([
    columns.address, columns.city, columns.state, columns.zip, columns.county, columns.lat, columns.lng
  ].filter(Boolean));

  const byKey = new Map();
  let skippedMissingAddress = 0;
  let duplicatesRemoved = 0;

  rows.forEach((row, index) => {
    const rawAddress = text(row[columns.address]);
    // Pasted sheets often repeat the header row mid-data; that is not a house.
    if (normalizeHeader(rawAddress) === normalizeHeader(columns.address)) return;
    if (!rawAddress) {
      if (Object.values(row).some((value) => !isBlank(value))) skippedMissingAddress += 1;
      return;
    }

    const { street, unit } = splitStreetAndUnit(rawAddress);
    const city = tidyCase(columns.city ? row[columns.city] : '');
    const state = cleanState(columns.state ? row[columns.state] : '');
    const zip = cleanZip(columns.zip ? row[columns.zip] : '');
    const displayStreet = tidyCase(street);
    const key = addressDedupeKey({ address: rawAddress, zip });
    const ownerName = tidyCase(composeOwnerName(row, columns));
    const county = columns.county ? resolveCounty(row[columns.county]) : '';

    const existing = byKey.get(key);
    if (existing) {
      duplicatesRemoved += 1;
      if (!existing.ownerName && ownerName) existing.ownerName = ownerName;
      if (!existing.county && county) existing.county = county;
      Object.keys(row).forEach((header) => {
        if (!mappedHeaders.has(header) && isBlank(existing.extras[header]) && !isBlank(row[header])) existing.extras[header] = row[header];
      });
      return;
    }

    const extras = {};
    Object.keys(row).forEach((header) => {
      if (!mappedHeaders.has(header) && !isBlank(row[header])) extras[header] = typeof row[header] === 'string' ? text(row[header]) : row[header];
    });

    byKey.set(key, {
      id: `row${index}`,
      rowNumber: index + 2, // spreadsheet row: 1-based, plus the header row
      key,
      displayStreet,
      unit,
      city,
      state,
      zip,
      ownerName,
      county,
      extras,
      coords: rowCoordinates(row, columns),
      query: { address: displayStreet, city, state, zip }
    });
  });

  const candidates = Array.from(byKey.values());
  if (candidates.length === 0) {
    throw new Error('No addresses found in this file. Check that it has an Address column with street addresses.');
  }

  const { resolved, batchFailed, fallbackSkipped } = await geocodeCandidates(candidates, deps);

  const importedAt = new Date().toISOString();
  const properties = [];
  const unmatched = [];
  let geocodedByCensus = 0;
  let geocodedByGeocodio = 0;
  let geocodedByFallback = 0;

  candidates.forEach((candidate) => {
    const hit = candidate.coords ? { ...candidate.coords, source: 'file' } : resolved.get(candidate.id);
    const fullAddress = [candidate.displayStreet, candidate.unit].filter(Boolean).join(' ');
    if (!hit) {
      unmatched.push({
        rowNumber: candidate.rowNumber,
        address: fullAddress,
        city: candidate.city,
        state: candidate.state,
        zip: candidate.zip
      });
      return;
    }
    if (hit.source === 'census') geocodedByCensus += 1;
    if (hit.source === 'geocodio') geocodedByGeocodio += 1;
    if (hit.source === 'nominatim') geocodedByFallback += 1;

    const houseNumber = parseHouseNumber(candidate.displayStreet);
    const streetName = candidate.displayStreet.replace(/^\d+\s*/, '').trim() || 'Unknown Street';
    const raw_metadata = {
      ...candidate.extras,
      list_name: listName,
      geocode_source: hit.source,
      imported_at: importedAt
    };
    if (candidate.county) raw_metadata.county = candidate.county;
    if (hit.matchType) raw_metadata.geocode_match = hit.matchType;
    if (candidate.unit) raw_metadata.unit = candidate.unit;

    properties.push({
      address_hash: `list_${hashString(`${candidate.key}|${hit.lat}|${hit.lng}`)}`.slice(0, 32),
      house_number: houseNumber ?? 0,
      street_name: streetName,
      full_address: fullAddress,
      address: fullAddress,
      city: candidate.city || null,
      state: candidate.state || null,
      zip_code: candidate.zip || null,
      zip: candidate.zip || null,
      lat: hit.lat,
      lng: hit.lng,
      original_status: 'ELIGIBLE',
      data_source: 'csv_import',
      ...(candidate.ownerName ? { owner_full_name: candidate.ownerName } : {}),
      raw_metadata
    });
  });

  if (properties.length === 0) {
    throw new Error(batchFailed
      ? 'We could not look up any of these addresses right now. Check your connection and try again.'
      : 'None of the addresses in this file could be placed on the map. Check the street, city and ZIP columns.');
  }

  return {
    fileName,
    routeName: listName,
    source: 'address_list',
    sourceLabel: 'Address list detected',
    properties,
    unmatched,
    summary: {
      ready: properties.length,
      skippedMissingAddress,
      duplicatesRemoved,
      geocodedByCensus,
      geocodedByGeocodio,
      geocodedByFallback,
      unmatched: unmatched.length,
      fallbackSkipped
    }
  };
}
