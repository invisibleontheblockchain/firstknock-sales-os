import { base44 } from '@/api/base44Client';
import { storage } from '@/lib/storage';
import { optimizeRouteByDistance } from '@/components/logic/routeOptimizer';

const REQUIRED_REDFIN_HEADERS = [
  'ADDRESS',
  'CITY',
  'STATE OR PROVINCE',
  'ZIP OR POSTAL CODE',
  'LATITUDE',
  'LONGITUDE'
];

const FIELD_COLUMNS = {
  address: 'ADDRESS',
  city: 'CITY',
  state: 'STATE OR PROVINCE',
  zip: 'ZIP OR POSTAL CODE',
  latitude: 'LATITUDE',
  longitude: 'LONGITUDE',
  sale_date: 'SOLD DATE',
  sale_price: 'PRICE',
  beds: 'BEDS',
  baths: 'BATHS',
  sqft: 'SQUARE FEET',
  year_built: 'YEAR BUILT',
  property_type: 'PROPERTY TYPE',
  status: 'STATUS'
};

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

const normalizeHeader = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

function getHeaders(rows = []) {
  const set = new Set();
  rows.forEach(row => Object.keys(row || {}).forEach(key => set.add(key)));
  return Array.from(set);
}

function findColumn(headers, target) {
  const normalizedTarget = normalizeHeader(target);
  return headers.find(header => {
    const normalized = normalizeHeader(header);
    return normalized === normalizedTarget || normalized.includes(normalizedTarget) || normalizedTarget.includes(normalized);
  }) || null;
}

function read(row, mapping, appField) {
  const column = mapping[appField];
  return column ? row[column] : null;
}

function cleanZip(value) {
  if (isBlank(value)) return null;
  return String(value).trim().replace(/\.0$/, '').slice(0, 10);
}

function parseNumberOrNull(value) {
  if (isBlank(value)) return null;
  const text = String(value).replace(/[$,]/g, '').trim();
  if (!text || /^nan$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function cleanScalar(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text || /^nan$/i.test(text)) return null;
  return text;
}

function parseRedfinSoldDate(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  const match = text.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  const day = String(Number(match[2])).padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function parseLatLng(row, mapping) {
  const lat = parseNumberOrNull(read(row, mapping, 'latitude'));
  const lng = parseNumberOrNull(read(row, mapping, 'longitude'));
  if (lat === null || lng === null) return { lat: null, lng: null };
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return { lat: null, lng: null };
  return { lat, lng };
}

function normalizeAddressKey(address, zip) {
  return `${String(address || '').trim().toLowerCase()}|${String(zip || '').trim()}`;
}

function hashString(input) {
  let hash = 0;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function makeAddressHash({ address, zip, lat, lng }) {
  return `redfin_${hashString(`${address || ''}|${zip || ''}|${lat || ''}|${lng || ''}`)}`.slice(0, 32);
}

function parseStreet(address) {
  const text = String(address || '').trim();
  const parts = text.split(/\s+/);
  const houseNumber = Number.parseInt(parts[0], 10);
  return {
    house_number: Number.isFinite(houseNumber) ? houseNumber : 0,
    street_name: Number.isFinite(houseNumber) ? parts.slice(1).join(' ') || 'Unknown Street' : text || 'Unknown Street'
  };
}

async function geocodeAddress({ address, city, state, zip }) {
  const query = [address, city, state, zip].filter(Boolean).join(', ');
  if (!query) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  const lat = parseNumberOrNull(first?.lat);
  const lng = parseNumberOrNull(first?.lon);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function routeNameFromFile(fileName) {
  return String(fileName || 'Imported Route')
    .replace(/\.[^.]+$/, '')
    .replace(/^[a-f0-9]{6,}_/i, '')
    .replace(/(\d{5})([A-Za-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Imported Route';
}

function buildMapping(headers) {
  return Object.fromEntries(
    Object.entries(FIELD_COLUMNS).map(([field, column]) => [field, findColumn(headers, column)])
  );
}

export function isRedfinCsvData(rows = []) {
  const headers = getHeaders(rows);
  return REQUIRED_REDFIN_HEADERS.every(required => !!findColumn(headers, required));
}

export async function prepareRedfinCsvImport(rows = [], fileName = 'Imported Route.csv') {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Unable to read this file. Please upload a valid CSV file.');
  }
  if (!isRedfinCsvData(rows)) return null;
  if (rows.length > 1000) {
    throw new Error(`This file has ${rows.length} rows. Maximum is 1,000. Please split the file and import in batches.`);
  }

  const headers = getHeaders(rows);
  const mapping = buildMapping(headers);
  const mappedColumns = new Set(Object.values(mapping).filter(Boolean));
  const candidates = [];
  let skippedMissingAddress = 0;

  for (const row of rows) {
    const saleType = cleanScalar(row[findColumn(headers, 'SALE TYPE')]);
    const address = cleanScalar(read(row, mapping, 'address'));
    const { lat: csvLat, lng: csvLng } = parseLatLng(row, mapping);

    if (saleType !== 'PAST SALE' && !address) continue;
    if (!address && (csvLat === null || csvLng === null)) {
      skippedMissingAddress += 1;
      continue;
    }

    const city = cleanScalar(read(row, mapping, 'city'));
    const state = cleanScalar(read(row, mapping, 'state'));
    const zip = cleanZip(read(row, mapping, 'zip'));
    let lat = csvLat;
    let lng = csvLng;

    if (address && (lat === null || lng === null)) {
      const geocoded = await geocodeAddress({ address, city, state, zip });
      if (geocoded) {
        lat = geocoded.lat;
        lng = geocoded.lng;
      }
    }

    if (lat === null || lng === null) {
      skippedMissingAddress += 1;
      continue;
    }

    const { house_number, street_name } = parseStreet(address);
    const saleDate = parseRedfinSoldDate(read(row, mapping, 'sale_date'));
    const raw_metadata = {};
    headers.forEach(header => {
      if (!mappedColumns.has(header)) raw_metadata[header] = cleanScalar(row[header]);
    });

    candidates.push({
      address_hash: makeAddressHash({ address, zip, lat, lng }),
      house_number,
      street_name,
      full_address: address || [city, state, zip].filter(Boolean).join(', '),
      address: address || null,
      city,
      state,
      zip_code: zip,
      zip,
      lat,
      lng,
      sale_date: saleDate,
      sold_date: saleDate,
      sale_price: parseNumberOrNull(read(row, mapping, 'sale_price')),
      price: parseNumberOrNull(read(row, mapping, 'sale_price')),
      beds: parseNumberOrNull(read(row, mapping, 'beds')),
      baths: parseNumberOrNull(read(row, mapping, 'baths')),
      sqft: parseNumberOrNull(read(row, mapping, 'sqft')),
      year_built: parseNumberOrNull(read(row, mapping, 'year_built')),
      property_type: cleanScalar(read(row, mapping, 'property_type')),
      status: cleanScalar(read(row, mapping, 'status')),
      original_status: /sold/i.test(String(read(row, mapping, 'status') || '')) ? 'SOLD' : 'ELIGIBLE',
      sale_type: saleType,
      data_source: 'redfin_csv',
      raw_metadata
    });
  }

  const deduped = new Map();
  let duplicatesRemoved = 0;
  candidates.forEach(property => {
    const key = property.address ? normalizeAddressKey(property.address, property.zip_code) : `${property.lat}|${property.lng}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, property);
      return;
    }
    duplicatesRemoved += 1;
    const existingTime = existing.sale_date ? new Date(existing.sale_date).getTime() : 0;
    const nextTime = property.sale_date ? new Date(property.sale_date).getTime() : 0;
    if (nextTime > existingTime) deduped.set(key, property);
  });

  const properties = Array.from(deduped.values());
  if (properties.length === 0) {
    throw new Error('No valid properties found in this file. Please check the file and try again.');
  }

  return {
    fileName,
    routeName: routeNameFromFile(fileName),
    properties,
    summary: {
      ready: properties.length,
      skippedMissingAddress,
      duplicatesRemoved
    }
  };
}

function computeDistanceMiles(properties = []) {
  let total = 0;
  for (let i = 0; i < properties.length - 1; i += 1) {
    const a = properties[i];
    const b = properties[i + 1];
    const r = 3959;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    total += r * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  return Math.round(total * 100) / 100;
}

export async function createRouteFromRedfinImport(importBatch, { user, startLocation = null } = {}) {
  const userEmail = user?.email || 'unknown@user.local';
  const managerId = user?.id || null;
  const importDate = new Date().toISOString().slice(0, 10);
  const ordered = optimizeRouteByDistance(importBatch.properties, startLocation);
  const properties = ordered.map(property => ({ ...property, created_by: userEmail }));

  const BATCH_SIZE = 500;
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    await base44.entities.MasterProperty.bulkCreate(properties.slice(i, i + BATCH_SIZE));
  }
  await storage.saveProperties(properties);

  const routePayload = {
    name: importBatch.routeName,
    route_mode: 'precision',
    status: 'ACTIVE',
    property_hashes: properties.map(p => p.address_hash),
    metrics: {
      distance: computeDistanceMiles(properties),
      house_count: properties.length,
      score: 100
    },
    start_location: startLocation || undefined,
    manager_id: managerId,
    assigned_to: managerId,
    assigned_to_name: user?.full_name || 'Me',
    metadata: {
      source: 'redfin_csv',
      import_date: importDate,
      file_name: importBatch.fileName
    }
  };

  const savedRoute = await base44.entities.SavedRoute.create(routePayload);
  return {
    ...savedRoute,
    ...routePayload,
    id: savedRoute?.id,
    properties,
    allProperties: properties,
    houseCount: properties.length,
    totalDistance: routePayload.metrics.distance,
    competitivenessScore: routePayload.metrics.score,
    isSaved: true
  };
}