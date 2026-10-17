// US Census batch geocoder. Free, keyless, and far better than Nominatim at
// exact house numbers (37/41 vs 26/41 on the Tampa sample). It sends no CORS
// headers, so browsers must reach it through the geocodeAddressBatch function.

export const CENSUS_BATCH_ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
export const CENSUS_BENCHMARK = 'Public_AR_Current';
export const CENSUS_MAX_BATCH = 1000;
export const CENSUS_ONELINE_ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

function csvCell(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCensusBatchCsv(items = []) {
  return items
    .map((item) => [item.id, item.address, item.city, item.state, item.zip].map(csvCell).join(','))
    .join('\n');
}

// Minimal RFC 4180 line parser: the Census response quotes every field and the
// coordinate cell ("-82.48,27.94") contains a comma.
export function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

/**
 * Parse a Census batch response into `{ [id]: { lat, lng, matchedAddress, matchType } }`.
 * Rows that are No_Match / Tie / malformed are simply absent from the result.
 */
/** Ids the batch answered with "Tie": several candidates, and no point. */
export function parseCensusBatchTies(text) {
  return String(text || '').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    const [id, , status] = parseCsvLine(line);
    return id && String(status).trim() === 'Tie' ? [id] : [];
  });
}

export function parseCensusBatchResponse(text) {
  const results = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const cells = parseCsvLine(line);
    const [id, , status, matchType, matchedAddress, coordinates] = cells;
    if (!id || String(status).trim() !== 'Match') return;
    const [lngText, latText] = String(coordinates || '').split(',');
    const lng = Number(lngText);
    const lat = Number(latText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    results[id] = { lat, lng, matchedAddress: matchedAddress || '', matchType: matchType || '' };
  });
  return results;
}

export async function geocodeWithCensus(items, { fetchImpl = globalThis.fetch, signal, tiedIds = null } = {}) {
  if (!Array.isArray(items) || items.length === 0) return {};
  if (items.length > CENSUS_MAX_BATCH) throw new Error(`Census batches are limited to ${CENSUS_MAX_BATCH} addresses.`);
  const form = new FormData();
  form.append('addressFile', new Blob([buildCensusBatchCsv(items)], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', CENSUS_BENCHMARK);
  const response = await fetchImpl(CENSUS_BATCH_ENDPOINT, { method: 'POST', body: form, signal });
  if (!response?.ok) throw new Error(`Census geocoder returned ${response?.status || 'no response'}.`);
  const text = await response.text();
  if (Array.isArray(tiedIds)) tiedIds.push(...parseCensusBatchTies(text));
  return parseCensusBatchResponse(text);
}

/**
 * Every candidate the single-address endpoint lists for one address, in its
 * order, marked matchType "Tie". Used only for addresses the batch tied on
 * (e.g. "SADDLETREE RD" vs "SADDLE TREE RD"); the caller decides which, if any,
 * is acceptable.
 */
export async function geocodeCensusCandidates(item, { fetchImpl = globalThis.fetch, signal } = {}) {
  const url = new URL(CENSUS_ONELINE_ENDPOINT);
  url.searchParams.set('address', [item.address, item.city, [item.state, item.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '));
  url.searchParams.set('benchmark', CENSUS_BENCHMARK);
  url.searchParams.set('format', 'json');
  const response = await fetchImpl(url.toString(), { signal });
  if (!response?.ok) throw new Error(`Census geocoder returned ${response?.status || 'no response'}.`);
  const matches = (await response.json())?.result?.addressMatches;
  return (Array.isArray(matches) ? matches : []).flatMap((match) => {
    const lat = Number(match?.coordinates?.y), lng = Number(match?.coordinates?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    return [{ lat, lng, matchedAddress: String(match.matchedAddress || ''), matchType: 'Tie' }];
  });
}
