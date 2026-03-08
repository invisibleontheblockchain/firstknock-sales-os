/**
 * Regrid API Client for FirstKnock V2 — Production-Grade
 * 
 * Implements all architectural requirements from the Regrid Integration Blueprint:
 *   ✅ Rate limiting with exponential backoff + jitter (HTTP 429 + Retry-After)
 *   ✅ Cursor-based pagination via offset_id
 *   ✅ ll_stack_uuid handling for condo/multi-unit flattening
 *   ✅ ll_row_parcel filtering (right-of-way exclusion)
 *   ✅ Typeahead API for address autocomplete
 *   ✅ Payload optimization (return_geometry, return_stacked flags)
 *   ✅ Enhanced Ownership (eo_owner, eo_last_refresh)
 * 
 * Field mapping (Regrid → FirstKnock):
 *   owner          → owner_name
 *   saledate       → sold_date
 *   saleprice      → sold_price
 *   parval         → assessed_value
 *   mailadd        → mailing_address
 *   usedesc        → property_type
 *   yearbuilt      → year_built
 *   ll_uuid        → regrid_id
 *   ll_stack_uuid  → stack_id (for multi-unit flattening)
 *   ll_row_parcel  → is_right_of_way (for ROW exclusion)
 */

const REGRID_BASE_URL = 'https://app.regrid.com/api/v2';

// ─── TOKEN MANAGEMENT ─────────────────────────────────────────
// Blueprint: Separate tokens for different operations
let _token = null;

export function setRegridToken(token) {
  _token = token;
}

export function getRegridToken() {
  return _token;
}

// ─── RATE LIMITING ────────────────────────────────────────────
// Blueprint: 10 simultaneous connections, ~200 requests/min
// HTTP 429 → read Retry-After → exponential backoff with jitter

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff with jitter:
 * W(n) = (B × 2^n) + J
 * Jitter prevents thundering herd when multiple agents retry simultaneously
 */
function getBackoffDelay(attempt) {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS; // Random 0-1000ms
  return exponential + jitter;
}

/**
 * Core fetch with rate-limit handling and retry logic.
 * Reads Retry-After header on 429, falls back to exponential backoff.
 */
async function regridFetch(endpoint, params = {}) {
  if (!_token) throw new Error('Regrid API token not set. Call setRegridToken() first.');
  
  const url = new URL(`${REGRID_BASE_URL}${endpoint}`);
  url.searchParams.set('token', _token);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString());
    
    // Success
    if (res.ok) {
      const data = await res.json();
      return data.parcels?.features || data.features || [];
    }
    
    // Rate limited — 429 Too Many Requests
    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Regrid API rate limit exceeded after ${MAX_RETRIES} retries`);
      }
      
      // Read Retry-After header (seconds)
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter 
        ? parseInt(retryAfter, 10) * 1000 
        : getBackoffDelay(attempt);
      
      console.warn(`[Regrid] 429 rate limited. Waiting ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }
    
    // Other errors — don't retry
    const text = await res.text();
    throw new Error(`Regrid API error ${res.status}: ${text}`);
  }
}

// ─── NORMALIZER ───────────────────────────────────────────────

/**
 * Normalize a Regrid parcel feature into FirstKnock property format.
 * Includes ll_stack_uuid for condo flattening and ll_row_parcel for ROW exclusion.
 */
export function normalizeParcel(feature) {
  const f = feature.properties?.fields || feature.properties || {};
  const geom = feature.geometry;
  
  return {
    // IDs
    regrid_id: f.ll_uuid || f.ogc_fid,
    ogc_fid: f.ogc_fid || null, // Needed for cursor-based pagination
    parcelnumb: f.parcelnumb,
    
    // Stacked parcel grouping (condos, multi-unit)
    stack_id: f.ll_stack_uuid || null,
    
    // Right-of-way flag (highways, utility easements, railways)
    is_right_of_way: (f.ll_row_parcel || '').toLowerCase() === 'true' || f.ll_row_parcel === true,
    
    // Address
    address: f.address || '',
    city: f.scity || f.city || '',
    state: f.state2 || '',
    zip: f.szip || f.szip5 || '',
    latitude: parseFloat(f.lat) || null,
    longitude: parseFloat(f.lon) || null,
    
    // Owner
    owner_name: f.owner || '',
    owner_first: f.ownfrst || '',
    owner_last: f.ownlast || '',
    previous_owner: f.previous_owner || '',
    
    // Mailing (for absentee owner detection)
    mailing_address: f.mailadd || '',
    mailing_city: f.mail_city || '',
    mailing_state: f.mail_state2 || '',
    mailing_zip: f.mail_zip || '',
    
    // Sale data (what our reps care about most)
    sold_date: f.saledate || f.last_ownership_transfer_date || null,
    sold_price: f.saleprice ? Number(f.saleprice) : null,
    
    // Property details
    assessed_value: f.parval ? Number(f.parval) : null,
    improvement_value: f.improvval ? Number(f.improvval) : null,
    land_value: f.landval ? Number(f.landval) : null,
    year_built: f.yearbuilt ? Number(f.yearbuilt) : null,
    bedrooms: f.num_bedrooms ? Number(f.num_bedrooms) : null,
    bathrooms: f.num_bath ? Number(f.num_bath) : null,
    stories: f.numstories ? Number(f.numstories) : null,
    sqft: f.sqft ? Number(f.sqft) : null,
    lot_acres: f.ll_gisacre ? Number(f.ll_gisacre) : null,
    
    // Type
    use_code: f.usecode || '',
    use_description: f.usedesc || '',
    zoning_type: f.zoning_type || '',
    zoning_subtype: f.zoning_subtype || '',
    
    // Premium enrichments
    homestead_exemption: f.homestead_exemption || null,
    usps_vacancy: f.usps_vacancy || null,
    rdi: f.rdi || null, // Residential Delivery Indicator
    building_footprint_sqft: f.ll_bldg_footprint_sqft ? Number(f.ll_bldg_footprint_sqft) : null,
    
    // Status (for the property card and routing)
    property_type: categorizePropertyType(f.usedesc, f.zoning_subtype),
    is_absentee: isAbsenteeOwner(f),
    
    // Geometry (property boundary polygon)
    boundary: geom,
    
    // Enhanced Ownership (daily-updated fields, requires EO add-on)
    enhanced_owner_name: f.eo_owner || null,
    enhanced_owner_first: f.eo_deedownerfirst || null,
    enhanced_owner_last: f.eo_deedownerlast || null,
    enhanced_owner_refreshed_at: f.eo_last_refresh || null,
    
    // Metadata
    data_updated_at: f.ll_updated_at || null,
    building_count: f.ll_bldg_count ? Number(f.ll_bldg_count) : null,

    // Backward-compatible fields for existing PropertyCard / route logic
    status: 'ELIGIBLE',
    source: 'regrid',
  };
}

/**
 * Categorize property type from use description
 */
function categorizePropertyType(usedesc, zoningSubtype) {
  const desc = (usedesc || '').toLowerCase();
  const zoning = (zoningSubtype || '').toLowerCase();
  
  if (desc.includes('single') || desc.includes('one family') || zoning.includes('single')) return 'Single Family';
  if (desc.includes('condo')) return 'Condo';
  if (desc.includes('townhouse') || desc.includes('town house')) return 'Townhouse';
  if (desc.includes('multi') || desc.includes('duplex') || desc.includes('triplex')) return 'Multi-Family';
  if (desc.includes('mobile') || desc.includes('manufactured')) return 'Mobile Home';
  if (desc.includes('residential') || desc.includes('res ')) return 'Residential';
  if (desc.includes('commercial') || desc.includes('office')) return 'Commercial';
  if (desc.includes('vacant') || desc.includes('land')) return 'Vacant Land';
  return 'Other';
}

/**
 * Detect absentee owner (mailing address differs from property address)
 */
function isAbsenteeOwner(fields) {
  if (!fields.mailadd || !fields.address) return false;
  const mail = (fields.mailadd || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const prop = (fields.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return mail !== prop && mail.length > 0 && prop.length > 0;
}

// ─── API METHODS ──────────────────────────────────────────────

/**
 * Search parcels by lat/lon point.
 * Uses radius for GPS drift tolerance (Blueprint: conservative 20m radius).
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude  
 * @param {object} opts - { radius, returnGeometry }
 */
export async function searchByPoint(lat, lon, opts = {}) {
  const params = { 
    lat, lon, 
    return_enhanced_ownership: 'true',
    return_stacked: opts.returnStacked !== false ? 'true' : 'false',
  };
  if (opts.radius) params.radius = opts.radius;
  if (opts.returnGeometry === false) params.return_geometry = 'false';
  
  const features = await regridFetch('/parcels/point', params);
  return features.map(normalizeParcel);
}

/**
 * Search parcels by address string.
 */
export async function searchByAddress(query, opts = {}) {
  const params = { 
    query, 
    return_enhanced_ownership: 'true',
    return_stacked: opts.returnStacked !== false ? 'true' : 'false',
  };
  if (opts.returnGeometry === false) params.return_geometry = 'false';
  
  const features = await regridFetch('/parcels/address', params);
  return features.map(normalizeParcel);
}

/**
 * Typeahead API — high-speed address autocomplete.
 * Blueprint: Cross-references 300M USPS-verified records.
 * Returns { ll_uuid, address, lat, lon } for instant lookup linking.
 * @param {string} query - Partial address string
 */
export async function typeahead(query) {
  if (!_token) throw new Error('Regrid API token not set.');
  
  const url = new URL(`${REGRID_BASE_URL}/typeahead`);
  url.searchParams.set('token', _token);
  url.searchParams.set('query', query);
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString());
    
    if (res.ok) {
      const data = await res.json();
      // Return simplified autocomplete results
      return (data.results || []).map(r => ({
        regrid_id: r.ll_uuid,
        address: r.address,
        city: r.city,
        state: r.state,
        zip: r.zip,
        latitude: r.lat ? parseFloat(r.lat) : null,
        longitude: r.lon ? parseFloat(r.lon) : null,
      }));
    }
    
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : getBackoffDelay(attempt);
      await sleep(waitMs);
      continue;
    }
    
    const text = await res.text();
    throw new Error(`Regrid Typeahead error ${res.status}: ${text}`);
  }
}

/**
 * Search parcels by owner name.
 */
export async function searchByOwner(owner, state, county, opts = {}) {
  const params = { 
    owner, state, county, 
    return_enhanced_ownership: 'true',
  };
  if (opts.returnGeometry === false) params.return_geometry = 'false';
  
  const features = await regridFetch('/parcels/owner', params);
  return features.map(normalizeParcel);
}

/**
 * Query parcels by field filters.
 * Blueprint: Supports up to 4 fields with operators (gt, lte, between, eq, ne, ilike).
 * @param {object} fieldFilters - e.g. { 'zoning_type': { eq: 'Residential' }, 'yearbuilt': { between: ['1990','2010'] } }
 * @param {object} opts - { limit, returnGeometry, returnStacked }
 */
export async function queryByFields(fieldFilters = {}, opts = {}) {
  const params = { 
    return_enhanced_ownership: 'true',
    return_stacked: opts.returnStacked !== false ? 'true' : 'false',
  };
  if (opts.limit) params.limit = opts.limit;
  if (opts.returnGeometry === false) params.return_geometry = 'false';
  
  // Compose field filter params: fields[field][operator]=value
  Object.entries(fieldFilters).forEach(([field, operators]) => {
    if (typeof operators === 'object') {
      Object.entries(operators).forEach(([op, val]) => {
        params[`fields[${field}][${op}]`] = typeof val === 'object' ? JSON.stringify(val) : String(val);
      });
    } else {
      params[`fields[${field}][eq]`] = String(operators);
    }
  });
  
  const features = await regridFetch('/parcels/query', params);
  return features.map(normalizeParcel);
}

/**
 * Fetch parcels within a bounding box.
 */
export async function searchByBoundingBox(southWest, northEast, opts = {}) {
  const params = {
    'fields[bbox]': `${southWest.lng},${southWest.lat},${northEast.lng},${northEast.lat}`,
    return_enhanced_ownership: 'true',
    return_stacked: 'false', // Suppress condo duplicates in area queries
  };
  if (opts.returnGeometry === false) params.return_geometry = 'false';
  if (opts.limit) params.limit = opts.limit;
  
  const features = await regridFetch('/parcels/query', params);
  return features.map(normalizeParcel);
}

/**
 * Paginated polygon search using cursor-based pagination (offset_id).
 * Blueprint: max 1000/page, uses ogc_fid from last record as next offset.
 * Automatically handles pagination until all records are retrieved.
 * 
 * @param {object} fieldFilters - Query field filters
 * @param {object} opts - { maxRecords, pageSize, onPage, returnGeometry }
 * @returns {Array} All normalized parcels
 */
export async function searchPaginated(fieldFilters = {}, opts = {}) {
  const maxRecords = opts.maxRecords || 10000;
  const pageSize = Math.min(opts.pageSize || 1000, 1000); // Hard cap at 1000
  const allParcels = [];
  let offsetId = 0;
  let pageCount = 0;
  
  while (allParcels.length < maxRecords) {
    const params = {
      return_enhanced_ownership: 'true',
      return_stacked: 'false',
      limit: pageSize,
      offset_id: offsetId,
    };
    if (opts.returnGeometry === false) params.return_geometry = 'false';
    
    // Add field filters
    Object.entries(fieldFilters).forEach(([field, operators]) => {
      if (typeof operators === 'object') {
        Object.entries(operators).forEach(([op, val]) => {
          params[`fields[${field}][${op}]`] = typeof val === 'object' ? JSON.stringify(val) : String(val);
        });
      } else {
        params[`fields[${field}][eq]`] = String(operators);
      }
    });
    
    const features = await regridFetch('/parcels/query', params);
    
    if (features.length === 0) break; // No more results
    
    const normalized = features.map(normalizeParcel);
    allParcels.push(...normalized);
    pageCount++;
    
    // Progress callback
    if (opts.onPage) {
      opts.onPage({ page: pageCount, total: allParcels.length, pageSize: features.length });
    }
    
    // Get ogc_fid from last record for next page cursor
    const lastFeature = features[features.length - 1];
    const lastOgcFid = lastFeature.properties?.fields?.ogc_fid || lastFeature.properties?.ogc_fid;
    
    if (!lastOgcFid) break; // Can't paginate further
    offsetId = lastOgcFid;
    
    // If we got fewer than requested, we've reached the end
    if (features.length < pageSize) break;
  }
  
  return allParcels;
}

// ─── STACKED PARCEL UTILITIES ─────────────────────────────────
// Blueprint: ll_stack_uuid groups condos sharing identical geometry.
// Render only ONE polygon per stack; show units in a scrollable list.

/**
 * Flatten stacked parcels — groups by ll_stack_uuid, returns unique geometries.
 * Each group contains a representative parcel (for map rendering) and a units array.
 * 
 * @param {Array} parcels - Normalized parcel array
 * @returns {Array} Parcels with stacked units grouped. Each has `.stacked_units` array.
 */
export function flattenStackedParcels(parcels) {
  const stackMap = new Map();
  const unstacked = [];
  
  for (const p of parcels) {
    if (p.stack_id) {
      if (!stackMap.has(p.stack_id)) {
        stackMap.set(p.stack_id, {
          representative: p,
          units: [p],
        });
      } else {
        stackMap.get(p.stack_id).units.push(p);
      }
    } else {
      unstacked.push(p);
    }
  }
  
  // For each stack, take the representative parcel and attach unit list
  const flattened = [];
  for (const [, stack] of stackMap) {
    flattened.push({
      ...stack.representative,
      stacked_units: stack.units,
      unit_count: stack.units.length,
      is_stacked: true,
    });
  }
  
  return [...unstacked, ...flattened];
}

// ─── FILTER UTILITIES (client-side, no API calls) ─────────────

/**
 * Filter properties by months since sale
 */
export function filterByMonths(properties, months) {
  if (!months) return properties;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return properties.filter(p => {
    if (!p.sold_date) return false;
    return new Date(p.sold_date) >= cutoff;
  });
}

/**
 * Filter properties by minimum assessed value
 */
export function filterByValue(properties, minValue) {
  if (!minValue) return properties;
  return properties.filter(p => (p.assessed_value || 0) >= minValue);
}

/**
 * Filter properties by type
 */
export function filterByType(properties, types) {
  if (!types || types.length === 0) return properties;
  return properties.filter(p => types.includes(p.property_type));
}

/**
 * Filter absentee owners only
 */
export function filterAbsentee(properties, absenteeOnly) {
  if (!absenteeOnly) return properties;
  return properties.filter(p => p.is_absentee);
}

/**
 * Exclude right-of-way parcels (highways, rivers, utility easements).
 * Blueprint: ll_row_parcel flag uses perimeter-to-area heuristics.
 */
export function filterRightOfWay(properties) {
  return properties.filter(p => !p.is_right_of_way);
}

/**
 * Filter USPS-vacant properties (postal carrier flagged as empty)
 */
export function filterVacant(properties, excludeVacant = true) {
  if (!excludeVacant) return properties;
  return properties.filter(p => {
    const vac = (p.usps_vacancy || '').toLowerCase();
    return vac !== 'y' && vac !== 'yes' && vac !== 'vacant';
  });
}

/**
 * Apply all filters at once.
 * Blueprint: ROW exclusion is ON by default.
 */
export function applyFilters(properties, filters = {}) {
  let result = properties;
  
  // Always exclude right-of-way unless explicitly disabled
  if (filters.includeRightOfWay !== true) {
    result = filterRightOfWay(result);
  }
  
  // Exclude USPS-vacant unless disabled
  if (filters.excludeVacant !== false) {
    result = filterVacant(result, true);
  }
  
  if (filters.months) result = filterByMonths(result, filters.months);
  if (filters.minValue) result = filterByValue(result, filters.minValue);
  if (filters.types?.length) result = filterByType(result, filters.types);
  if (filters.absenteeOnly) result = filterAbsentee(result, true);
  
  return result;
}
