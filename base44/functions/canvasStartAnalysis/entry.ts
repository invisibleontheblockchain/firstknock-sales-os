import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_POLYGON_POINTS = 800;
const MAX_AREA_SQ_MI = 50;
const MAX_LARGE_AREA_SQ_MI = 1_000;
const MAX_LARGE_BOUNDS_SQ_MI = 2_500;
const MAX_OSM_BYTES = 6_000_000;
const MAX_OSM_ELEMENTS = 150_000;
const MAX_SNAPSHOT_BYTES = 7_500_000;
const OVERPASS_TIMEOUT_MS = 120_000;
const LARGE_TILE_OSM_BYTES = 4_500_000;
const LARGE_TILE_OSM_ELEMENTS = 125_000;
const LARGE_TILE_RESULT_BYTES = 5_500_000;
const LARGE_TILE_TIMEOUT_MS = 25_000;
const LARGE_TILE_QUERY_MILES = 4.8;
const LARGE_TILE_CORE_MILES = 4.4;
const LARGE_TILE_BUFFER_MILES = (LARGE_TILE_QUERY_MILES - LARGE_TILE_CORE_MILES) / 2;
const LARGE_TILE_MIN_SQ_MI = 5;
const LARGE_TILE_MAX_SQ_MI = 25;
const MAX_LARGE_TILE_COUNT = 128;
const MAX_TILE_ATTEMPTS = 4;
const MAX_LARGE_TILE_EVIDENCE_RECORDS = MAX_LARGE_TILE_COUNT * MAX_TILE_ATTEMPTS;
const MAX_ACTIVE_ANALYSIS_JOBS_PER_MANAGER = 3;
const MAX_ANALYSIS_JOB_RUNTIME_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const ANALYSIS_LEASE_MS = 60_000;
const ANALYSIS_IDENTITY_LEASE_MS = 60_000;
const ANALYSIS_IDENTITY_LEASE_WAIT_MS = 2_000;
const MAX_LARGE_JOB_RAW_EVIDENCE_BYTES = 64_000_000;
const MAX_LARGE_JOB_RESULT_BYTES = 32_000_000;
const MAX_LARGE_JOB_INTERMEDIATE_BYTES = 80_000_000;
const INTERMEDIATE_STORAGE_POLICY = 'compact-terminal-intermediates-v1';
const TILE_PLAN_VERSION = 'canvas-grid-buffered-v2';
const PUBLIC_DEVELOPMENT_OVERPASS = 'https://overpass-api.de/api/interpreter';
const PUBLIC_OVERPASS_HOSTS = new Set([
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.nchc.org.tw',
  'overpass.openstreetmap.ru',
  'overpass.private.coffee',
  'maps.mail.ru'
]);
const RESIDENTIAL_BUILDINGS = new Set(['house', 'detached', 'semidetached_house', 'semi_detached', 'terrace', 'apartments', 'residential', 'dormitory', 'bungalow', 'cabin', 'farm', 'static_caravan', 'houseboat']);
const NON_RESIDENTIAL_BUILDINGS = new Set(['warehouse', 'office', 'industrial', 'retail', 'commercial', 'school', 'church', 'hospital', 'garage', 'parking']);
const NON_RESIDENTIAL_LANDUSE = new Set(['industrial', 'commercial', 'retail']);
const TRANSIT_HIGHWAYS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);

class HttpError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, message: string, details: any = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function isoInstant(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function betaGrantResolution(user: any) {
  const userId = String(user?.id || '');
  if (!userId) return { present: false, grant: null };
  const encoded = Deno.env.get('BETA_ACCESS_GRANTS');
  if (!encoded) return { present: false, grant: null };
  let document: any;
  try { document = JSON.parse(encoded); } catch { return { present: false, grant: null }; }
  if (!document || Array.isArray(document) || document.version !== 1 || !document.grants || Array.isArray(document.grants) || typeof document.grants !== 'object') return { present: false, grant: null };
  if (!Object.prototype.hasOwnProperty.call(document.grants, userId)) return { present: false, grant: null };
  const candidate = document.grants[userId];
  const startsAt = isoInstant(candidate?.starts_at);
  const endsAt = isoInstant(candidate?.ends_at);
  if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object'
    || typeof candidate.grant_id !== 'string' || !candidate.grant_id.trim() || candidate.grant_id !== candidate.grant_id.trim() || candidate.grant_id.length > 256
    || candidate.status !== 'active' || typeof candidate.precision_limit !== 'number' || typeof candidate.canvas_seats !== 'number'
    || !Number.isSafeInteger(candidate.precision_limit) || candidate.precision_limit < 1 || candidate.precision_limit > 1_000
    || !Number.isSafeInteger(candidate.canvas_seats) || candidate.canvas_seats < 1 || candidate.canvas_seats > 100
    || startsAt === null || endsAt === null || startsAt >= endsAt || Date.now() < startsAt || Date.now() >= endsAt) return { present: true, grant: null };
  return { present: true, grant: candidate };
}

function hasCanvasDraftAccess(user: any) {
  if (normalized(user?.role || user?.data?.role) === 'admin') return true;
  const beta = betaGrantResolution(user);
  if (beta.present) return Boolean(beta.grant);
  if (normalized(user?.subscription_tier) !== 'canvas') return false;
  const status = normalized(user?.subscription_status);
  return status === 'active' && user?.subscription_paid_confirmed === true
    || status === 'trialing' && user?.stripe_card_on_file_confirmed === true;
}

function normalizePoint(value: any, field: string) {
  const lat = Number(value?.lat ?? value?.[0]);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude ?? value?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, 'invalid_polygon', `${field} contains an invalid coordinate.`);
  }
  return { lat, lng };
}

function normalizePolygon(value: any) {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_POLYGON_POINTS) {
    throw new HttpError(400, 'invalid_polygon', `polygon must contain 3-${MAX_POLYGON_POINTS} points.`);
  }
  const points = value.map((point, index) => normalizePoint(point, `polygon[${index}]`));
  if (points.length > 3 && points[0].lat === points.at(-1)?.lat && points[0].lng === points.at(-1)?.lng) points.pop();
  if (new Set(points.map((point) => `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`)).size < 3) {
    throw new HttpError(400, 'invalid_polygon', 'polygon needs at least three unique points.');
  }
  return points;
}

function polygonAreaSqMi(points: any[]) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const origin = points[0];
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const projected = points.map((point) => ({ x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale }));
  let twiceArea = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const next = projected[(index + 1) % projected.length];
    twiceArea += projected[index].x * next.y - next.x * projected[index].y;
  }
  return Math.abs(twiceArea) / 2;
}

function polygonBounds(points: any[]) {
  return points.reduce((bounds, point) => ({
    minLat: Math.min(bounds.minLat, point.lat),
    maxLat: Math.max(bounds.maxLat, point.lat),
    minLng: Math.min(bounds.minLng, point.lng),
    maxLng: Math.max(bounds.maxLng, point.lng)
  }), { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 });
}

function boundsAreaSqMi(bounds: any) {
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const height = Math.max(0, bounds.maxLat - bounds.minLat) * 69;
  const width = Math.max(0, bounds.maxLng - bounds.minLng) * 69 * Math.max(0.01, Math.cos(centerLat * Math.PI / 180));
  return height * width;
}

function pointInPolygon(point: any, polygon: any[]) {
  let inside = false;
  for (let left = 0, right = polygon.length - 1; left < polygon.length; right = left, left += 1) {
    const a = polygon[left];
    const b = polygon[right];
    const crosses = (a.lat > point.lat) !== (b.lat > point.lat)
      && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / ((b.lat - a.lat) || Number.EPSILON) + a.lng;
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a: any, b: any, c: any) {
  const value = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  return Math.abs(value) < 1e-12 ? 0 : value > 0 ? 1 : -1;
}

function onSegment(a: any, b: any, c: any) {
  return Math.min(a.lat, c.lat) - 1e-12 <= b.lat && b.lat <= Math.max(a.lat, c.lat) + 1e-12
    && Math.min(a.lng, c.lng) - 1e-12 <= b.lng && b.lng <= Math.max(a.lng, c.lng) + 1e-12;
}

function segmentsIntersect(a: any, b: any, c: any, d: any) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return o1 === 0 && onSegment(a, c, b)
    || o2 === 0 && onSegment(a, d, b)
    || o3 === 0 && onSegment(c, a, d)
    || o4 === 0 && onSegment(c, b, d);
}

function rectanglePolygon(minLat: number, maxLat: number, minLng: number, maxLng: number) {
  return [
    { lat: minLat, lng: minLng },
    { lat: minLat, lng: maxLng },
    { lat: maxLat, lng: maxLng },
    { lat: maxLat, lng: minLng }
  ];
}

function rectangleIntersectsPolygon(rectangle: any[], polygon: any[]) {
  if (rectangle.some((point) => pointInPolygon(point, polygon))) return true;
  const minLat = Math.min(...rectangle.map((point) => point.lat));
  const maxLat = Math.max(...rectangle.map((point) => point.lat));
  const minLng = Math.min(...rectangle.map((point) => point.lng));
  const maxLng = Math.max(...rectangle.map((point) => point.lng));
  if (polygon.some((point) => point.lat >= minLat && point.lat <= maxLat && point.lng >= minLng && point.lng <= maxLng)) return true;
  for (let polygonIndex = 0; polygonIndex < polygon.length; polygonIndex += 1) {
    const a = polygon[polygonIndex];
    const b = polygon[(polygonIndex + 1) % polygon.length];
    for (let rectangleIndex = 0; rectangleIndex < rectangle.length; rectangleIndex += 1) {
      const c = rectangle[rectangleIndex];
      const d = rectangle[(rectangleIndex + 1) % rectangle.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

async function largeTilePlan(polygon: any[]) {
  const bounds = polygonBounds(polygon);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  if (Math.abs(centerLat) > 75 || bounds.maxLng - bounds.minLng > 180) {
    throw new HttpError(422, 'canvas_large_area_projection_unsupported', 'Large Canvas analysis does not support polar or antimeridian-spanning boundaries.');
  }
  const boundingArea = boundsAreaSqMi(bounds);
  if (boundingArea > MAX_LARGE_BOUNDS_SQ_MI) {
    throw new HttpError(422, 'canvas_large_area_bounds_too_sparse', `The boundary bounding box exceeds ${MAX_LARGE_BOUNDS_SQ_MI} square miles. Draw separate contiguous work areas.`);
  }
  const latStep = LARGE_TILE_CORE_MILES / 69;
  const lngStep = LARGE_TILE_CORE_MILES / (69 * Math.max(0.01, Math.cos(centerLat * Math.PI / 180)));
  const latBuffer = LARGE_TILE_BUFFER_MILES / 69;
  const lngBuffer = LARGE_TILE_BUFFER_MILES / (69 * Math.max(0.01, Math.cos(centerLat * Math.PI / 180)));
  const tiles: any[] = [];
  let row = 0;
  for (let minLat = bounds.minLat; minLat < bounds.maxLat + 1e-10; minLat += latStep, row += 1) {
    let column = 0;
    for (let minLng = bounds.minLng; minLng < bounds.maxLng + 1e-10; minLng += lngStep, column += 1) {
      const core = rectanglePolygon(minLat, minLat + latStep, minLng, minLng + lngStep);
      if (!rectangleIntersectsPolygon(core, polygon)) continue;
      const query = rectanglePolygon(
        Math.max(-90, minLat - latBuffer),
        Math.min(90, minLat + latStep + latBuffer),
        Math.max(-180, minLng - lngBuffer),
        Math.min(180, minLng + lngStep + lngBuffer)
      );
      const queryArea = boundsAreaSqMi(polygonBounds(query));
      if (queryArea < LARGE_TILE_MIN_SQ_MI || queryArea > LARGE_TILE_MAX_SQ_MI + 0.01) {
        throw new HttpError(500, 'canvas_tile_plan_invalid', 'The server generated a tile outside its 5-25 square-mile safety envelope.');
      }
      const descriptor = { tile_index: tiles.length, row, column, core_polygon: core, query_polygon: query, query_area_sq_mi: Number(queryArea.toFixed(3)) };
      const tileHash = await sha256({ tile_plan_version: TILE_PLAN_VERSION, ...descriptor });
      tiles.push({ ...descriptor, tile_id: `canvas_tile_${tileHash}`, tile_hash: tileHash });
      if (tiles.length > MAX_LARGE_TILE_COUNT) {
        throw new HttpError(422, 'canvas_large_area_too_complex', `The boundary requires more than ${MAX_LARGE_TILE_COUNT} analysis tiles. Draw a less fragmented boundary or split it into separate plans.`);
      }
    }
  }
  if (!tiles.length) throw new HttpError(422, 'canvas_large_area_empty_tile_plan', 'Canvas could not generate analysis tiles for this boundary.');
  return tiles;
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonicalize(value))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function overpassEndpoint() {
  const configured = String(Deno.env.get('CANVAS_OVERPASS_URL') || '').trim();
  if (configured) {
    let parsed: URL;
    try { parsed = new URL(configured); } catch { throw new HttpError(503, 'canvas_analysis_provider_invalid', 'CANVAS_OVERPASS_URL must be a valid private HTTPS endpoint.'); }
    if (parsed.protocol !== 'https:') {
      throw new HttpError(503, 'canvas_analysis_provider_not_private', 'CANVAS_OVERPASS_URL must use HTTPS. Plain HTTP OSM evidence is not trusted.');
    }
    if (PUBLIC_OVERPASS_HOSTS.has(parsed.hostname.toLowerCase())) {
      if (Deno.env.get('CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK') === 'true') {
        return { url: configured, provider: 'openstreetmap-public-development-fallback', development_fallback: true };
      }
      throw new HttpError(503, 'canvas_analysis_provider_not_private', 'A known public Overpass host is allowed only as the explicitly enabled development fallback.');
    }
    return { url: configured, provider: 'openstreetmap-contracted-or-self-hosted', development_fallback: false };
  }
  if (Deno.env.get('CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK') === 'true') {
    return { url: PUBLIC_DEVELOPMENT_OVERPASS, provider: 'openstreetmap-public-development-fallback', development_fallback: true };
  }
  throw new HttpError(503, 'canvas_analysis_provider_unavailable', 'CANVAS_OVERPASS_URL is required for production analysis. Public Overpass is disabled unless the explicit development fallback flag is enabled.');
}

function largeAreaOverpassEndpoint() {
  const configured = String(Deno.env.get('CANVAS_OVERPASS_LARGE_AREA_URL') || Deno.env.get('CANVAS_OVERPASS_URL') || '').trim();
  if (!configured) {
    throw new HttpError(503, 'canvas_large_analysis_provider_unavailable', 'A contracted or self-hosted CANVAS_OVERPASS_LARGE_AREA_URL is required for large Canvas analysis.');
  }
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new HttpError(503, 'canvas_large_analysis_provider_invalid', 'The configured large-area OSM endpoint is invalid.'); }
  if (parsed.protocol !== 'https:' || PUBLIC_OVERPASS_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new HttpError(503, 'canvas_large_analysis_provider_not_private', 'Large Canvas analysis requires a private HTTPS OSM endpoint; public Overpass instances are not permitted.');
  }
  return { url: configured, provider: 'openstreetmap-contracted-or-self-hosted', development_fallback: false };
}

function providerHeaders() {
  const token = String(Deno.env.get('CANVAS_OVERPASS_AUTH_TOKEN') || '').trim();
  return {
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function overpassQuery(polygon: any[], timeoutSeconds = 110) {
  const poly = polygon.map((point) => `${point.lat.toFixed(7)} ${point.lng.toFixed(7)}`).join(' ');
  return `[out:json][timeout:${timeoutSeconds}];(
way["highway"](poly:"${poly}");
node["highway"~"^(turning_circle|turning_loop)$"](poly:"${poly}");
node["noexit"](poly:"${poly}");
nwr["building"](poly:"${poly}");
nwr["addr:housenumber"](poly:"${poly}");
nwr["addr:unit"](poly:"${poly}");
node["entrance"](poly:"${poly}");
relation["type"="associatedStreet"](poly:"${poly}");
nwr["landuse"](poly:"${poly}");
nwr["shop"](poly:"${poly}");
nwr["office"](poly:"${poly}");
nwr["amenity"](poly:"${poly}");
nwr["barrier"](poly:"${poly}");
nwr["access"](poly:"${poly}");
nwr["foot"](poly:"${poly}");
nwr["access:conditional"](poly:"${poly}");
nwr["foot:conditional"](poly:"${poly}");
nwr["locked"](poly:"${poly}");
nwr["building:use"](poly:"${poly}");
nwr["building:flats"](poly:"${poly}");
nwr["building:units"](poly:"${poly}");
nwr["residential:units"](poly:"${poly}");
nwr["units:residential"](poly:"${poly}");
nwr["residential"](poly:"${poly}");
nwr["mixed_use"](poly:"${poly}");
nwr["natural"](poly:"${poly}");
);out body;>;out skel qt;`;
}

async function readBoundedJson(response: Response) {
  if (!response.ok) throw new HttpError(502, 'canvas_analysis_provider_failed', `The configured OSM provider returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OSM_BYTES) throw new HttpError(413, 'canvas_analysis_too_large', 'The OSM response exceeds the Phase 1 payload limit.');
  if (!response.body) throw new HttpError(502, 'canvas_analysis_provider_failed', 'The OSM provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OSM_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'canvas_analysis_too_large', 'The OSM response exceeds the Phase 1 payload limit.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new HttpError(502, 'canvas_analysis_provider_invalid', 'The OSM provider returned invalid JSON.');
  }
  if (!Array.isArray(payload?.elements) || payload.elements.length > MAX_OSM_ELEMENTS) {
    throw new HttpError(413, 'canvas_analysis_too_complex', `The OSM response must contain at most ${MAX_OSM_ELEMENTS} elements.`);
  }
  return payload;
}

async function readBoundedTileJson(response: Response) {
  if (!response.ok) {
    const status = response.status === 429 ? 429 : 502;
    throw new HttpError(status, 'canvas_tile_provider_failed', `The configured large-area OSM provider returned HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LARGE_TILE_OSM_BYTES) throw new HttpError(413, 'canvas_tile_too_large', 'A large-area OSM tile exceeded its payload limit.');
  if (!response.body) throw new HttpError(502, 'canvas_tile_provider_failed', 'The large-area OSM provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > LARGE_TILE_OSM_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'canvas_tile_too_large', 'A large-area OSM tile exceeded its payload limit.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: any;
  try { payload = JSON.parse(new TextDecoder().decode(merged)); } catch { throw new HttpError(502, 'canvas_tile_provider_invalid', 'The large-area OSM provider returned invalid JSON.'); }
  if (!Array.isArray(payload?.elements) || payload.elements.length > LARGE_TILE_OSM_ELEMENTS) {
    throw new HttpError(413, 'canvas_tile_too_complex', `A large-area OSM tile must contain at most ${LARGE_TILE_OSM_ELEMENTS} elements.`);
  }
  return { payload, bytes, element_count: payload.elements.length };
}

function distanceMeters(left: any, right: any) {
  const lat = (left.lat + right.lat) / 2 * Math.PI / 180;
  const dx = (right.lng - left.lng) * 111_320 * Math.cos(lat);
  const dy = (right.lat - left.lat) * 110_540;
  return Math.hypot(dx, dy);
}

function distanceToSegmentMeters(point: any, start: any, end: any) {
  const referenceLat = point.lat * Math.PI / 180;
  const project = (value: any) => ({ x: (value.lng - point.lng) * 111_320 * Math.cos(referenceLat), y: (value.lat - point.lat) * 110_540 });
  const a = project(start);
  const b = project(end);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator > 0 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / denominator)) : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

function nearPolygonBoundary(point: any, polygon: any[]) {
  return polygon.some((start, index) => distanceToSegmentMeters(point, start, polygon[(index + 1) % polygon.length]) <= 25);
}

function normalizedRawEvidence(payload: any) {
  const byIdentity = new Map<string, any>();
  for (const element of Array.isArray(payload?.elements) ? payload.elements : []) {
    const candidate = {
      type: String(element?.type || ''),
      id: Number(element?.id),
      ...(Number.isFinite(Number(element?.lat)) && Number.isFinite(Number(element?.lon)) ? { lat: Number(element.lat), lon: Number(element.lon) } : {}),
      ...(Number.isFinite(Number(element?.center?.lat)) && Number.isFinite(Number(element?.center?.lon))
        ? { center: { lat: Number(element.center.lat), lon: Number(element.center.lon) } } : {}),
      ...(Array.isArray(element?.nodes) ? { nodes: element.nodes.map(Number).filter(Number.isFinite) } : {}),
      ...(Array.isArray(element?.members) ? { members: element.members.map((member: any) => ({
        type: String(member?.type || ''), ref: Number(member?.ref), role: String(member?.role || '')
      })).filter((member: any) => member.type && Number.isFinite(member.ref)) } : {}),
      ...(element?.tags && typeof element.tags === 'object' ? { tags: canonicalize(element.tags) } : {})
    };
    if (!candidate.type || !Number.isFinite(candidate.id)) continue;
    const identity = `${candidate.type}:${candidate.id}`;
    const previous = byIdentity.get(identity);
    byIdentity.set(identity, previous ? {
      ...previous,
      ...candidate,
      ...(previous.tags || candidate.tags ? { tags: canonicalize({ ...(previous.tags || {}), ...(candidate.tags || {}) }) } : {}),
      ...((previous.nodes?.length || 0) > (candidate.nodes?.length || 0) ? { nodes: previous.nodes } : {}),
      ...((previous.members?.length || 0) > (candidate.members?.length || 0) ? { members: previous.members } : {})
    } : candidate);
  }
  const elements = [...byIdentity.values()].sort((left: any, right: any) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  return {
    osm_base: String(payload?.osm3s?.timestamp_osm_base || 'unknown'),
    elements
  };
}

function classifyStreetEvidenceLegacy(raw: any, polygon: any[]) {
  const nodes = new Map(raw.elements.filter((element: any) => element.type === 'node' && Number.isFinite(element.lat) && Number.isFinite(element.lon)).map((node: any) => [node.id, { lat: node.lat, lng: node.lon }]));
  const roads = raw.elements.filter((element: any) => element.type === 'way' && element.tags?.highway && Array.isArray(element.nodes));
  const positiveBuildings = raw.elements.filter((element: any) => element.type === 'way'
    && Array.isArray(element.nodes)
    && (RESIDENTIAL_BUILDINGS.has(normalized(element.tags?.building))
      || ['residential', 'apartments'].includes(normalized(element.tags?.['building:use']))
      || ['yes', 'residential'].includes(normalized(element.tags?.mixed_use))));
  const buildingEvidence = new Map<number, { low: number; expected: number; high: number; sources: Set<string>; features: Map<string, any> }>();
  for (const building of positiveBuildings) {
    const points = building.nodes.map((id: number) => nodes.get(id)).filter(Boolean);
    if (!points.length) continue;
    const center = { lat: points.reduce((sum: number, point: any) => sum + point.lat, 0) / points.length, lng: points.reduce((sum: number, point: any) => sum + point.lng, 0) / points.length };
    const candidates: any[] = [];
    for (const road of roads) {
      const roadPoints = road.nodes.map((id: number) => nodes.get(id)).filter(Boolean);
      if (!roadPoints.length) continue;
      const distance = Math.min(...roadPoints.map((point: any) => distanceMeters(center, point)));
      if (distance <= 75) candidates.push({ road, distance });
    }
    candidates.sort((left, right) => left.distance - right.distance || left.road.id - right.road.id);
    if (!candidates.length || candidates[1] && candidates[1].distance - candidates[0].distance < 10) continue;
    const nearest = candidates[0];
    const explicit = Number(building.tags?.['building:units'] || building.tags?.['building:flats']);
    const hasAddress = Boolean(String(building.tags?.['addr:housenumber'] || '').trim());
    const apartment = normalized(building.tags?.building) === 'apartments';
    const contribution = Number.isSafeInteger(explicit) && explicit > 0
      ? { low: explicit, expected: explicit, high: explicit, source: 'explicit_building_units' }
      : apartment
        ? { low: 2, expected: 8, high: 30, source: 'apartment_footprint_wide_range' }
        : { low: 1, expected: 1, high: 1, source: hasAddress ? 'building_address' : 'residential_footprint' };
    const aggregate = buildingEvidence.get(nearest.road.id) || { low: 0, expected: 0, high: 0, sources: new Set<string>(), features: new Map<string, any>() };
    aggregate.low += contribution.low;
    aggregate.expected += contribution.expected;
    aggregate.high += contribution.high;
    aggregate.sources.add(contribution.source);
    aggregate.features.set(`osm_${building.type}_${building.id}`, {
      feature_id: `osm_${building.type}_${building.id}`,
      low: contribution.low,
      expected: contribution.expected,
      high: contribution.high,
      source: contribution.source,
      associated_unit_id: `osm_way_${nearest.road.id}`,
      association_distance_meters: Number(nearest.distance.toFixed(2))
    });
    buildingEvidence.set(nearest.road.id, aggregate);
  }
  const negativeRoadEvidence = new Set<number>();
  const negativeFeatures = raw.elements.filter((element: any) => element.type === 'way' && Array.isArray(element.nodes)
    && !['yes', 'residential'].includes(normalized(element.tags?.mixed_use))
    && !['residential', 'apartments'].includes(normalized(element.tags?.['building:use']))
    && (NON_RESIDENTIAL_BUILDINGS.has(normalized(element.tags?.building)) || NON_RESIDENTIAL_LANDUSE.has(normalized(element.tags?.landuse))));
  for (const feature of negativeFeatures) {
    const points = feature.nodes.map((id: number) => nodes.get(id)).filter(Boolean);
    if (!points.length) continue;
    const center = { lat: points.reduce((sum: number, point: any) => sum + point.lat, 0) / points.length, lng: points.reduce((sum: number, point: any) => sum + point.lng, 0) / points.length };
    const candidates = roads.map((road: any) => {
      const roadPoints = road.nodes.map((id: number) => nodes.get(id)).filter(Boolean);
      return { road, distance: roadPoints.length ? Math.min(...roadPoints.map((point: any) => distanceMeters(center, point))) : Number.POSITIVE_INFINITY };
    }).filter((candidate: any) => candidate.distance <= 75).sort((left: any, right: any) => left.distance - right.distance || left.road.id - right.road.id);
    if (candidates.length && (!candidates[1] || candidates[1].distance - candidates[0].distance >= 10)) negativeRoadEvidence.add(candidates[0].road.id);
  }
  const units = roads.map((road: any) => {
    const points = road.nodes.map((id: number) => nodes.get(id)).filter(Boolean);
    const segments = points.slice(0, -1).map((start: any, index: number) => ({
      edge_id: `osm_way_${road.id}_${index}`,
      start,
      end: points[index + 1],
      street_names: road.tags?.name ? [String(road.tags.name)] : [],
      length_meters: Number(distanceMeters(start, points[index + 1]).toFixed(2))
    }));
    const foot = normalized(road.tags?.foot);
    const generalAccess = normalized(road.tags?.access);
    const footExplicitlyPermitted = ['yes', 'designated', 'permissive'].includes(foot);
    const restricted = foot ? ['no', 'private'].includes(foot) : ['no', 'private'].includes(generalAccess);
    const evidence = buildingEvidence.get(road.id);
    const opportunity = evidence ? 'likely' : negativeRoadEvidence.has(road.id) ? 'none' : 'uncertain';
    const access = restricted ? 'restricted' : footExplicitlyPermitted || !generalAccess || !['no', 'private'].includes(generalAccess) ? 'permitted' : 'uncertain';
    const canvasRole = restricted || opportunity === 'none' ? 'excluded' : opportunity === 'likely' ? 'knock' : TRANSIT_HIGHWAYS.has(normalized(road.tags?.highway)) ? 'transit_only' : 'uncertain';
    const unitId = `osm_way_${road.id}`;
    return {
      id: unitId,
      unit_id: unitId,
      kind: normalized(road.tags?.highway),
      canvas_role: canvasRole,
      opportunity_classification: opportunity,
      access_classification: access,
      opportunity_low: canvasRole === 'knock' ? evidence.low : 0,
      opportunity_expected: canvasRole === 'knock' ? evidence.expected : 0,
      opportunity_high: canvasRole === 'knock' ? evidence.high : 0,
      opportunity_source: evidence ? [...evidence.sources].sort().join('+') : 'none',
      opportunity_features: evidence ? [...evidence.features.values()].sort((left: any, right: any) => left.feature_id.localeCompare(right.feature_id)) : [],
      confidence: evidence ? evidence.sources.has('explicit_building_units') || evidence.sources.has('building_address') ? 'high' : 'medium' : 'uncertain',
      protected: false,
      street_names: road.tags?.name ? [String(road.tags.name)] : [],
      neighbor_ids: [],
      street_length_meters: Number(segments.reduce((sum: number, segment: any) => sum + segment.length_meters, 0).toFixed(2)),
      segments
    };
  }).filter((unit: any) => unit.segments.length > 0).sort((left: any, right: any) => left.unit_id.localeCompare(right.unit_id));
  const includedIds = new Set(units.map((unit: any) => unit.unit_id));
  const nodeToUnitIds = new Map<number, Set<string>>();
  for (const road of roads) {
    const unitId = `osm_way_${road.id}`;
    if (!includedIds.has(unitId)) continue;
    for (const nodeId of road.nodes) {
      if (!nodeToUnitIds.has(nodeId)) nodeToUnitIds.set(nodeId, new Set());
      nodeToUnitIds.get(nodeId)?.add(unitId);
    }
  }
  const turningCircleNodeIds = new Set(raw.elements
    .filter((element: any) => element.type === 'node' && ['turning_circle', 'turning_loop'].includes(normalized(element.tags?.highway)))
    .map((element: any) => element.id));
  const noExitNodeIds = new Set(raw.elements
    .filter((element: any) => element.type === 'node' && normalized(element.tags?.noexit) === 'yes')
    .map((element: any) => element.id));
  const roadByUnitId = new Map(roads.map((road: any) => [`osm_way_${road.id}`, road]));
  return units.map((unit: any) => {
    const road: any = roadByUnitId.get(unit.unit_id);
    const neighbors = new Set<string>();
    for (const nodeId of road.nodes) for (const neighborId of nodeToUnitIds.get(nodeId) || []) if (neighborId !== unit.unit_id) neighbors.add(neighborId);
    const firstNodeId = road.nodes[0];
    const lastNodeId = road.nodes.at(-1);
    const firstPoint = nodes.get(firstNodeId);
    const lastPoint = nodes.get(lastNodeId);
    const protectedTerminal = (Boolean(firstPoint) && (nodeToUnitIds.get(firstNodeId)?.size || 0) === 1 && !nearPolygonBoundary(firstPoint, polygon))
      || (Boolean(lastPoint) && (nodeToUnitIds.get(lastNodeId)?.size || 0) === 1 && !nearPolygonBoundary(lastPoint, polygon))
      || road.nodes.some((nodeId: number) => turningCircleNodeIds.has(nodeId));
    return { ...unit, neighbor_ids: [...neighbors].sort(), protected: protectedTerminal };
  });
}

function pointOnPolygonBoundary(point: any, polygon: any[]) {
  return polygon.some((start, index) => distanceToSegmentMeters(point, start, polygon[(index + 1) % polygon.length]) <= 0.05);
}

function streetNameKey(value: unknown) {
  const suffixes: Record<string, string> = {
    avenue: 'ave', boulevard: 'blvd', circle: 'cir', court: 'ct', drive: 'dr', lane: 'ln',
    parkway: 'pkwy', place: 'pl', road: 'rd', street: 'st'
  };
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((part) => suffixes[part] || part).join(' ');
}

function positiveInteger(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : null;
}

function interpolatePoint(start: any, end: any, position: number) {
  return {
    lat: start.lat + (end.lat - start.lat) * position,
    lng: start.lng + (end.lng - start.lng) * position
  };
}

function segmentPolygonParameters(start: any, end: any, polygon: any[]) {
  const result = [0, 1];
  const direction = { x: end.lng - start.lng, y: end.lat - start.lat };
  const lengthSquared = direction.x * direction.x + direction.y * direction.y;
  if (!(lengthSquared > 0)) return result;
  const cross = (left: any, right: any) => left.x * right.y - left.y * right.x;
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    const edge = { x: edgeEnd.lng - edgeStart.lng, y: edgeEnd.lat - edgeStart.lat };
    const offset = { x: edgeStart.lng - start.lng, y: edgeStart.lat - start.lat };
    const denominator = cross(direction, edge);
    if (Math.abs(denominator) <= 1e-12) {
      if (Math.abs(cross(offset, direction)) > 1e-12) continue;
      for (const candidate of [edgeStart, edgeEnd]) {
        const position = ((candidate.lng - start.lng) * direction.x + (candidate.lat - start.lat) * direction.y) / lengthSquared;
        if (position >= -1e-9 && position <= 1 + 1e-9) result.push(Math.max(0, Math.min(1, position)));
      }
      continue;
    }
    const position = cross(offset, edge) / denominator;
    const edgePosition = cross(offset, direction) / denominator;
    if (position >= -1e-9 && position <= 1 + 1e-9 && edgePosition >= -1e-9 && edgePosition <= 1 + 1e-9) {
      result.push(Math.max(0, Math.min(1, position)));
    }
  }
  return [...new Set(result.map((value) => Number(value.toFixed(10))))].sort((left, right) => left - right);
}

function clipRoadEdgeToPolygon(start: any, end: any, polygon: any[], roadId: number, edgeIndex: number) {
  const positions = segmentPolygonParameters(start, end, polygon);
  const intervals: any[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const from = positions[index];
    const to = positions[index + 1];
    if (to - from <= 1e-9) continue;
    const midpoint = interpolatePoint(start, end, (from + to) / 2);
    if (!pointInPolygon(midpoint, polygon) && !pointOnPolygonBoundary(midpoint, polygon)) continue;
    const previous = intervals.at(-1);
    if (previous && Math.abs(previous.to - from) <= 1e-9) {
      previous.to = to;
      previous.end = interpolatePoint(start, end, to);
      previous.end_original = to >= 1 - 1e-9;
      continue;
    }
    intervals.push({
      road_id: roadId,
      raw_edge_index: edgeIndex,
      from,
      to,
      start: interpolatePoint(start, end, from),
      end: interpolatePoint(start, end, to),
      start_original: from <= 1e-9,
      end_original: to >= 1 - 1e-9
    });
  }
  return intervals;
}

function fractionToken(value: number) {
  return Math.round(value * 1_000_000_000).toString(36);
}

function buildClippedStreetUnits(raw: any, nodes: Map<number, any>, roads: any[], polygon: any[]) {
  const nodeDegree = new Map<number, number>();
  const edgeByKey = new Map<string, any>();
  const nodeEdges = new Map<number, Set<string>>();
  for (const road of roads) {
    for (let index = 0; index < road.nodes.length - 1; index += 1) {
      const startId = road.nodes[index];
      const endId = road.nodes[index + 1];
      if (!nodes.has(startId) || !nodes.has(endId) || startId === endId) continue;
      const edgeKey = `${road.id}:${index}`;
      edgeByKey.set(edgeKey, { edge_key: edgeKey, start_node_id: startId, end_node_id: endId });
      nodeDegree.set(startId, (nodeDegree.get(startId) || 0) + 1);
      nodeDegree.set(endId, (nodeDegree.get(endId) || 0) + 1);
      if (!nodeEdges.has(startId)) nodeEdges.set(startId, new Set());
      if (!nodeEdges.has(endId)) nodeEdges.set(endId, new Set());
      nodeEdges.get(startId)?.add(edgeKey);
      nodeEdges.get(endId)?.add(edgeKey);
    }
  }
  const turningCircleNodeIds = new Set(raw.elements
    .filter((element: any) => element.type === 'node' && ['turning_circle', 'turning_loop'].includes(normalized(element.tags?.highway)))
    .map((element: any) => element.id));
  const noExitNodeIds = new Set(raw.elements
    .filter((element: any) => element.type === 'node' && normalized(element.tags?.noexit) === 'yes')
    .map((element: any) => element.id));
  const explicitProtectedOriginNodeIds = new Set([...turningCircleNodeIds, ...noExitNodeIds]);
  const protectedGroupCandidates = new Map<string, Set<string>>();
  const protectedOriginCandidates = new Map<string, Set<number>>();
  const explicitProtectedOriginCandidates = new Map<string, Set<number>>();
  const terminalNodeIds = [...nodeDegree.keys()].filter((nodeId) => {
    const point = nodes.get(nodeId);
    return (nodeDegree.get(nodeId) || 0) === 1 && point
      && (pointInPolygon(point, polygon) || pointOnPolygonBoundary(point, polygon))
      && !nearPolygonBoundary(point, polygon);
  });
  const protectedOrigins = [...new Set([...terminalNodeIds, ...turningCircleNodeIds, ...noExitNodeIds])].sort((left, right) => left - right);
  for (const originNodeId of protectedOrigins) {
    const originEdges = [...(nodeEdges.get(originNodeId) || [])].sort();
    const groupKind = turningCircleNodeIds.has(originNodeId) ? 'osm_turning'
      : noExitNodeIds.has(originNodeId) ? 'osm_noexit' : 'osm_terminal';
    const groupId = `${groupKind}_${originNodeId}`;
    for (const originEdgeKey of originEdges) {
      let nodeId = originNodeId;
      let edgeKey: string | null = originEdgeKey;
      const visited = new Set<string>();
      while (edgeKey && !visited.has(edgeKey) && visited.size <= edgeByKey.size) {
        visited.add(edgeKey);
        if (!protectedGroupCandidates.has(edgeKey)) protectedGroupCandidates.set(edgeKey, new Set());
        if (!protectedOriginCandidates.has(edgeKey)) protectedOriginCandidates.set(edgeKey, new Set());
        protectedGroupCandidates.get(edgeKey)?.add(groupId);
        protectedOriginCandidates.get(edgeKey)?.add(originNodeId);
        if (explicitProtectedOriginNodeIds.has(originNodeId)) {
          if (!explicitProtectedOriginCandidates.has(edgeKey)) explicitProtectedOriginCandidates.set(edgeKey, new Set());
          explicitProtectedOriginCandidates.get(edgeKey)?.add(originNodeId);
        }
        const edge = edgeByKey.get(edgeKey);
        if (!edge) break;
        const nextNodeId = edge.start_node_id === nodeId ? edge.end_node_id : edge.start_node_id;
        if (nextNodeId === originNodeId || (nodeDegree.get(nextNodeId) || 0) !== 2) break;
        const nextEdges = [...(nodeEdges.get(nextNodeId) || [])].filter((candidate) => candidate !== edgeKey).sort();
        if (nextEdges.length !== 1) break;
        nodeId = nextNodeId;
        edgeKey = nextEdges[0];
      }
    }
  }
  const protectedGroupByEdge = new Map([...protectedGroupCandidates.entries()]
    .map(([edgeKey, groups]) => [edgeKey, [...groups].sort()[0]]));
  const units: any[] = [];
  for (const road of roads) {
    const roadIntervals: any[] = [];
    for (let edgeIndex = 0; edgeIndex < road.nodes.length - 1; edgeIndex += 1) {
      const start = nodes.get(road.nodes[edgeIndex]);
      const end = nodes.get(road.nodes[edgeIndex + 1]);
      if (!start || !end || distanceMeters(start, end) <= 0.01) continue;
      for (const interval of clipRoadEdgeToPolygon(start, end, polygon, road.id, edgeIndex)) {
        roadIntervals.push({
          ...interval,
          start_node_id: interval.start_original ? road.nodes[edgeIndex] : null,
          end_node_id: interval.end_original ? road.nodes[edgeIndex + 1] : null,
          source_edge_id: `osm_way_${road.id}_${edgeIndex}`,
          source_way_id: road.id,
          source_edge_index: edgeIndex,
          source_edge_start_node_id: road.nodes[edgeIndex],
          source_edge_end_node_id: road.nodes[edgeIndex + 1],
          protected_group_ids: [...(protectedGroupCandidates.get(`${road.id}:${edgeIndex}`) || [])].sort(),
          protected_origin_node_ids: [...(protectedOriginCandidates.get(`${road.id}:${edgeIndex}`) || [])].sort((left, right) => left - right),
          explicit_protected_origin_node_ids: [...(explicitProtectedOriginCandidates.get(`${road.id}:${edgeIndex}`) || [])]
            .sort((left, right) => left - right)
        });
      }
    }
    const runs: any[][] = [];
    for (const interval of roadIntervals) {
      const run = runs.at(-1);
      const previous = run?.at(-1);
      const sharedNodeId = previous?.end_node_id !== null && previous?.end_node_id === interval.start_node_id
        ? interval.start_node_id : null;
      const sameProtectedGroup = String(protectedGroupByEdge.get(`${road.id}:${previous?.raw_edge_index}`) || '')
        === String(protectedGroupByEdge.get(`${road.id}:${interval.raw_edge_index}`) || '');
      const mayCoalesce = Boolean(previous
        && previous.raw_edge_index + 1 === interval.raw_edge_index
        && previous.to >= 1 - 1e-9 && interval.from <= 1e-9
        && sharedNodeId !== null && (nodeDegree.get(sharedNodeId) || 0) === 2
        && !turningCircleNodeIds.has(sharedNodeId) && !noExitNodeIds.has(sharedNodeId)
        && sameProtectedGroup);
      if (mayCoalesce) run.push(interval);
      else runs.push([interval]);
    }
    for (const run of runs) {
      const first = run[0];
      const last = run.at(-1);
      const preserveSingleEdgeId = road.nodes.length === 2 && run.length === 1
        && first.from <= 1e-9 && first.to >= 1 - 1e-9;
      const unitId = preserveSingleEdgeId ? `osm_way_${road.id}`
        : `osm_block_${road.id}_${first.raw_edge_index}_${fractionToken(first.from)}_${last.raw_edge_index}_${fractionToken(last.to)}`;
      const protectedGroupIds = [...new Set(run.flatMap((interval: any) => interval.protected_group_ids))].sort();
      const protectedOriginNodeIds = [...new Set(run.flatMap((interval: any) => interval.protected_origin_node_ids))].sort((left, right) => left - right);
      const explicitProtectedOriginIds = [...new Set(run.flatMap((interval: any) => interval.explicit_protected_origin_node_ids))]
        .sort((left, right) => left - right);
      const firstPoint = first.start_node_id === null ? null : nodes.get(first.start_node_id);
      const lastPoint = last.end_node_id === null ? null : nodes.get(last.end_node_id);
      const protectedTerminal = protectedGroupIds.length > 0
        || (Boolean(firstPoint) && (nodeDegree.get(first.start_node_id) || 0) === 1 && !nearPolygonBoundary(firstPoint, polygon))
        || (Boolean(lastPoint) && (nodeDegree.get(last.end_node_id) || 0) === 1 && !nearPolygonBoundary(lastPoint, polygon))
        || turningCircleNodeIds.has(first.start_node_id) || turningCircleNodeIds.has(last.end_node_id);
      const segments = run.map((interval: any) => {
        const fullInterval = interval.from <= 1e-9 && interval.to >= 1 - 1e-9;
        const edgeId = fullInterval ? interval.source_edge_id
          : `${interval.source_edge_id}_${fractionToken(interval.from)}_${fractionToken(interval.to)}`;
        return {
          edge_id: edgeId,
          source_edge_id: interval.source_edge_id,
          source_way_id: interval.source_way_id,
          source_edge_index: interval.source_edge_index,
          source_from: interval.from,
          source_to: interval.to,
          source_start_node_id: interval.start_node_id,
          source_end_node_id: interval.end_node_id,
          source_edge_start_node_id: interval.source_edge_start_node_id,
          source_edge_end_node_id: interval.source_edge_end_node_id,
          boundary_start: !interval.start_original,
          boundary_end: !interval.end_original,
          protected_origin_node_ids: interval.protected_origin_node_ids,
          explicit_protected_origin_node_ids: interval.explicit_protected_origin_node_ids,
          start: interval.start,
          end: interval.end,
          street_names: road.tags?.name ? [String(road.tags.name)] : [],
          length_meters: Number(distanceMeters(interval.start, interval.end).toFixed(2))
        };
      });
      units.push({
        id: unitId,
        unit_id: unitId,
        kind: normalized(road.tags?.highway),
        protected: protectedTerminal,
        protected_group_id: protectedGroupIds[0] || null,
        protected_group_ids: protectedGroupIds,
        protected_origin_node_ids: protectedOriginNodeIds,
        explicit_protected_origin_node_ids: explicitProtectedOriginIds,
        street_names: road.tags?.name ? [String(road.tags.name)] : [],
        neighbor_ids: [],
        street_length_meters: Number(segments.reduce((sum: number, segment: any) => sum + segment.length_meters, 0).toFixed(2)),
        source_way_id: road.id,
        source_edge_ids: run.map((interval: any) => interval.source_edge_id),
        segments,
        _road_id: road.id,
        _road_tags: road.tags || {},
        _source_node_ids: [...new Set(run.flatMap((interval: any) => [interval.source_edge_start_node_id, interval.source_edge_end_node_id]))],
        _first_node_id: first.start_node_id,
        _last_node_id: last.end_node_id,
        _polygon: polygon
      });
    }
  }
  const endpointUnits = new Map<number, Set<string>>();
  for (const unit of units) {
    for (const nodeId of [unit._first_node_id, unit._last_node_id]) {
      if (nodeId === null || nodeId === undefined) continue;
      if (!endpointUnits.has(nodeId)) endpointUnits.set(nodeId, new Set());
      endpointUnits.get(nodeId)?.add(unit.unit_id);
    }
  }
  return units.map((unit) => {
    const neighbors = new Set<string>();
    for (const nodeId of [unit._first_node_id, unit._last_node_id]) {
      for (const neighborId of endpointUnits.get(nodeId) || []) if (neighborId !== unit.unit_id) neighbors.add(neighborId);
    }
    return { ...unit, neighbor_ids: [...neighbors].sort() };
  }).sort((left, right) => left.unit_id.localeCompare(right.unit_id));
}

function streetUnitDistanceMeters(point: any, unit: any) {
  const distances = unit.segments.map((segment: any) => distanceToSegmentMeters(point, segment.start, segment.end));
  return distances.length ? Math.min(...distances) : Number.POSITIVE_INFINITY;
}

function assembleRelationRings(members: any[], wayById: Map<number, any>, nodes: Map<number, any>, role: string) {
  const sequences = members.filter((member) => member.type === 'way'
    && (role === 'outer' ? ['', 'outer'].includes(normalized(member.role)) : normalized(member.role) === 'inner'))
    .map((member) => ({ ref: member.ref, node_ids: [...(wayById.get(member.ref)?.nodes || [])] }))
    .filter((member) => member.node_ids.length >= 2)
    .sort((left, right) => left.ref - right.ref);
  const rings: any[][] = [];
  while (sequences.length) {
    const seed = sequences.shift();
    if (!seed) break;
    const chain = [...seed.node_ids];
    let changed = true;
    while (changed && sequences.length && chain[0] !== chain.at(-1)) {
      changed = false;
      for (let index = 0; index < sequences.length; index += 1) {
        const candidate = sequences[index].node_ids;
        if (chain.at(-1) === candidate[0]) chain.push(...candidate.slice(1));
        else if (chain.at(-1) === candidate.at(-1)) chain.push(...candidate.slice(0, -1).reverse());
        else if (chain[0] === candidate.at(-1)) chain.unshift(...candidate.slice(0, -1));
        else if (chain[0] === candidate[0]) chain.unshift(...candidate.slice(1).reverse());
        else continue;
        sequences.splice(index, 1);
        changed = true;
        break;
      }
    }
    const points = chain.map((nodeId) => nodes.get(nodeId)).filter(Boolean);
    if (points.length >= 3) rings.push(points);
  }
  return rings;
}

function relationBuildingGeometries(raw: any, nodes: Map<number, any>) {
  const wayById = new Map(raw.elements.filter((element: any) => element.type === 'way').map((way: any) => [way.id, way]));
  const geometries = new Map<string, any>();
  const parentByMember = new Map<string, string>();
  for (const relation of raw.elements.filter((element: any) => element.type === 'relation'
    && normalized(element.tags?.type) === 'multipolygon' && Array.isArray(element.members))) {
    const relationId = `osm_relation_${relation.id}`;
    const outerRings = assembleRelationRings(relation.members, wayById, nodes, 'outer');
    const innerRings = assembleRelationRings(relation.members, wayById, nodes, 'inner');
    if (outerRings.length) geometries.set(relationId, { outer_rings: outerRings, inner_rings: innerRings });
    if (normalized(relation.tags?.building) || normalized(relation.tags?.['building:use'])
      || normalized(relation.tags?.mixed_use) || normalized(relation.tags?.residential)) {
      for (const member of relation.members.filter((candidate: any) => candidate.type === 'way')) {
        parentByMember.set(`osm_way_${member.ref}`, relationId);
      }
    }
  }
  return { geometries, parent_by_member: parentByMember };
}

function relationGeometryContains(geometry: any, point: any) {
  return geometry?.outer_rings?.some((ring: any[]) => pointInPolygon(point, ring) || pointOnPolygonBoundary(point, ring))
    && !geometry?.inner_rings?.some((ring: any[]) => pointInPolygon(point, ring) || pointOnPolygonBoundary(point, ring));
}

function relationRepresentativePoint(geometry: any, polygon: any[]) {
  for (const ring of geometry?.outer_rings || []) {
    let twiceArea = 0;
    let latitude = 0;
    let longitude = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ring[index];
      const next = ring[(index + 1) % ring.length];
      const cross = current.lng * next.lat - next.lng * current.lat;
      twiceArea += cross;
      longitude += (current.lng + next.lng) * cross;
      latitude += (current.lat + next.lat) * cross;
    }
    const centroid = Math.abs(twiceArea) > 1e-15
      ? { lat: latitude / (3 * twiceArea), lng: longitude / (3 * twiceArea) }
      : { lat: ring.reduce((sum, point) => sum + point.lat, 0) / ring.length, lng: ring.reduce((sum, point) => sum + point.lng, 0) / ring.length };
    const candidates = [centroid, ...ring, ...ring.map((point, index) => interpolatePoint(point, ring[(index + 1) % ring.length], 0.5))];
    const selected = candidates.find((candidate) => relationGeometryContains(geometry, candidate)
      && (pointInPolygon(candidate, polygon) || pointOnPolygonBoundary(candidate, polygon)));
    if (selected) return selected;
  }
  return null;
}

function featureRepresentativePoint(feature: any, nodes: Map<number, any>, polygon: any[], relationGeometry: any = null) {
  const direct = Number.isFinite(feature?.lat) && Number.isFinite(feature?.lon) ? { lat: feature.lat, lng: feature.lon }
    : Number.isFinite(feature?.center?.lat) && Number.isFinite(feature?.center?.lon) ? { lat: feature.center.lat, lng: feature.center.lon } : null;
  if (direct) return direct;
  if (relationGeometry) return relationRepresentativePoint(relationGeometry, polygon);
  const points = Array.isArray(feature?.nodes) ? feature.nodes.map((id: number) => nodes.get(id)).filter(Boolean) : [];
  if (!points.length) return null;
  const center = {
    lat: points.reduce((sum: number, point: any) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum: number, point: any) => sum + point.lng, 0) / points.length
  };
  if (pointInPolygon(center, polygon) || pointOnPolygonBoundary(center, polygon)) return center;
  const inside = points.filter((point: any) => pointInPolygon(point, polygon) || pointOnPolygonBoundary(point, polygon));
  if (inside.length) return {
    lat: inside.reduce((sum: number, point: any) => sum + point.lat, 0) / inside.length,
    lng: inside.reduce((sum: number, point: any) => sum + point.lng, 0) / inside.length
  };
  for (let index = 0; index < points.length - 1; index += 1) {
    const intervals = clipRoadEdgeToPolygon(points[index], points[index + 1], polygon, feature.id, index);
    if (intervals.length) return interpolatePoint(intervals[0].start, intervals[0].end, 0.5);
  }
  return center;
}

function addressEvidenceKeys(feature: any, point: any, associatedStreetName = '') {
  const tags = feature.tags || {};
  const numbers = String(tags['addr:housenumber'] || '').split(/[;,]/).map((value) => normalized(value)).filter(Boolean);
  if (!numbers.length) return [];
  const units = String(tags['addr:unit'] || '').split(/[;,]/).map((value) => normalized(value)).filter(Boolean);
  const context = streetNameKey(tags['addr:street'] || associatedStreetName)
    || (point ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : `osm_${feature.type}_${feature.id}`);
  if (!units.length) return numbers.map((number) => `${context}\u0000${number}\u0000`);
  if (numbers.length === units.length) return numbers.map((number, index) => `${context}\u0000${number}\u0000${units[index]}`);
  if (numbers.length === 1) return units.map((unit) => `${context}\u0000${numbers[0]}\u0000${unit}`);
  return numbers.flatMap((number) => units.map((unit) => `${context}\u0000${number}\u0000${unit}`));
}

function featureEvidenceSignals(feature: any) {
  const tags = feature.tags || {};
  const building = normalized(tags.building);
  const buildingUse = normalized(tags['building:use']);
  const mixedUse = normalized(tags.mixed_use);
  const landuse = normalized(tags.landuse);
  const natural = normalized(tags.natural);
  const mixedResidential = ['mixed', 'mixed_use', 'residential', 'apartments'].includes(buildingUse)
    || ['yes', 'mixed', 'residential'].includes(mixedUse) || normalized(tags.residential) === 'yes';
  const residentialBuilding = RESIDENTIAL_BUILDINGS.has(building);
  return {
    residential: residentialBuilding || mixedResidential || landuse === 'residential',
    residentialBuilding,
    mixedResidential,
    multiUnit: ['apartments', 'dormitory', 'residential'].includes(building) || mixedResidential,
    ambiguousBuilding: building === 'yes',
    negative: NON_RESIDENTIAL_BUILDINGS.has(building) || NON_RESIDENTIAL_LANDUSE.has(landuse)
      || Boolean(normalized(tags.shop) || normalized(tags.office) || normalized(tags.amenity)),
    openLand: ['farmland', 'forest', 'grass', 'meadow', 'orchard'].includes(landuse) || ['field', 'grassland'].includes(natural),
    serviceEntrance: normalized(tags.entrance) === 'service'
  };
}

function associatedStreetHints(raw: any, units: any[]) {
  const hints = new Map<string, { unit_ids: Set<string>; name: string }>();
  for (const relation of raw.elements.filter((element: any) => element.type === 'relation'
    && normalized(element.tags?.type) === 'associatedstreet' && Array.isArray(element.members))) {
    const streetWayIds = new Set(relation.members.filter((member: any) => normalized(member.role) === 'street' && member.type === 'way').map((member: any) => member.ref));
    const unitIds = new Set(units.filter((unit) => streetWayIds.has(unit._road_id)).map((unit) => unit.unit_id));
    const relationName = String(relation.tags?.name || '').trim();
    for (const member of relation.members.filter((candidate: any) => normalized(candidate.role) !== 'street')) {
      const identity = `osm_${member.type}_${member.ref}`;
      const hint = hints.get(identity) || { unit_ids: new Set<string>(), name: '' };
      for (const unitId of unitIds) hint.unit_ids.add(unitId);
      if (!hint.name && relationName) hint.name = relationName;
      hints.set(identity, hint);
    }
  }
  return hints;
}

function nearestPointOnStreetUnit(point: any, unit: any) {
  let best: any = null;
  for (const segment of unit.segments) {
    const referenceLat = point.lat * Math.PI / 180;
    const project = (value: any) => ({
      x: (value.lng - point.lng) * 111_320 * Math.cos(referenceLat),
      y: (value.lat - point.lat) * 110_540
    });
    const start = project(segment.start);
    const end = project(segment.end);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const denominator = dx * dx + dy * dy;
    const position = denominator > 0 ? Math.max(0, Math.min(1, -(start.x * dx + start.y * dy) / denominator)) : 0;
    const distance = Math.hypot(start.x + position * dx, start.y + position * dy);
    if (!best || distance < best.distance) best = { distance, point: interpolatePoint(segment.start, segment.end, position) };
  }
  return best;
}

function sideOfStreetResolution(point: any, first: any, second: any) {
  if (first.unit._road_id === second.unit._road_id) return null;
  const sharedName = first.unit.street_names.some((name: string) => second.unit.street_names
    .some((other: string) => streetNameKey(name) === streetNameKey(other)));
  if (!sharedName) return null;
  const firstNearest = nearestPointOnStreetUnit(point, first.unit);
  const secondNearest = nearestPointOnStreetUnit(point, second.unit);
  if (!firstNearest || !secondNearest) return null;
  const latitude = point.lat * Math.PI / 180;
  const vector = (from: any, to: any) => ({
    x: (to.lng - from.lng) * 111_320 * Math.cos(latitude),
    y: (to.lat - from.lat) * 110_540
  });
  const between = vector(secondNearest.point, firstNearest.point);
  const separation = Math.hypot(between.x, between.y);
  if (separation < 2 || separation > 80) return null;
  const firstOutward = vector(firstNearest.point, point);
  const secondBetween = { x: -between.x, y: -between.y };
  const secondOutward = vector(secondNearest.point, point);
  const firstScore = (firstOutward.x * between.x + firstOutward.y * between.y) / separation;
  const secondScore = (secondOutward.x * secondBetween.x + secondOutward.y * secondBetween.y) / separation;
  if (firstScore > 1 && secondScore <= 1) return first;
  if (secondScore > 1 && firstScore <= 1) return second;
  return null;
}

function chooseAssociation(point: any, candidates: any[], basis: string, maximumDistance: number, exact = false) {
  const ranked = candidates.map((unit) => ({ unit, distance: streetUnitDistanceMeters(point, unit) }))
    .filter((candidate) => exact || candidate.distance <= maximumDistance)
    .sort((left, right) => left.distance - right.distance || left.unit.unit_id.localeCompare(right.unit.unit_id));
  if (!ranked.length) return null;
  const second = ranked.find((candidate) => candidate.unit.unit_id !== ranked[0].unit.unit_id);
  const sideResolved = second ? sideOfStreetResolution(point, ranked[0], second) : null;
  if (sideResolved) return {
    unit: sideResolved.unit,
    distance_meters: Number(sideResolved.distance.toFixed(2)),
    basis,
    resolution: 'side_of_street'
  };
  if (second && second.distance - ranked[0].distance < 10 && second.unit._road_id !== ranked[0].unit._road_id) return null;
  return {
    unit: ranked[0].unit,
    distance_meters: Number(ranked[0].distance.toFixed(2)),
    basis,
    resolution: 'nearest_within_hierarchy'
  };
}

function drivewayAssociationContext(contextWays: any[], units: any[], nodes: Map<number, any>) {
  const unitIdsByNode = new Map<number, Set<string>>();
  for (const unit of units) for (const nodeId of unit._source_node_ids || []) {
    if (!unitIdsByNode.has(nodeId)) unitIdsByNode.set(nodeId, new Set());
    unitIdsByNode.get(nodeId)?.add(unit.unit_id);
  }
  return contextWays.filter((way) => normalized(way.tags?.highway) === 'service')
    .map((way) => {
      const points = way.nodes.map((nodeId: number) => nodes.get(nodeId)).filter(Boolean);
      const unitIds = new Set<string>();
      for (const nodeId of way.nodes) for (const unitId of unitIdsByNode.get(nodeId) || []) unitIds.add(unitId);
      if (!unitIds.size && points.length) {
        const endpoints = [points[0], points.at(-1)];
        for (const endpoint of endpoints) {
          const ranked = units.map((unit) => ({ unit, distance: streetUnitDistanceMeters(endpoint, unit) }))
            .filter((candidate) => candidate.distance <= 20)
            .sort((left, right) => left.distance - right.distance || left.unit.unit_id.localeCompare(right.unit.unit_id));
          if (ranked.length && (!ranked[1] || ranked[1].distance - ranked[0].distance >= 5)) unitIds.add(ranked[0].unit.unit_id);
        }
      }
      return { way_id: way.id, node_ids: new Set(way.nodes), points, unit_ids: unitIds };
    }).filter((record) => record.points.length >= 2 && record.unit_ids.size);
}

function drivewayHintForFeature(feature: any, point: any, driveways: any[]) {
  const direct = driveways.filter((driveway) => feature.type === 'node' && driveway.node_ids.has(feature.id));
  const candidates = direct.length ? direct : point ? driveways.map((driveway) => ({
    ...driveway,
    distance: Math.min(...driveway.points.slice(0, -1).map((start: any, index: number) =>
      distanceToSegmentMeters(point, start, driveway.points[index + 1])))
  })).filter((driveway) => driveway.distance <= 25)
    .sort((left, right) => left.distance - right.distance || left.way_id - right.way_id) : [];
  if (!candidates.length) return null;
  if (!direct.length && candidates[1] && candidates[1].distance - candidates[0].distance < 5) return null;
  return { unit_ids: new Set(candidates[0].unit_ids), basis: 'driveway' };
}

function associateEvidenceFeature(feature: any, point: any, units: any[], associatedStreetHint: any, drivewayHint: any) {
  const associatedIds = associatedStreetHint?.unit_ids instanceof Set ? associatedStreetHint.unit_ids : new Set<string>();
  const associated = associatedIds.size ? units.filter((unit) => associatedIds.has(unit.unit_id)) : [];
  const addressStreet = streetNameKey(feature.tags?.['addr:street'] || associatedStreetHint?.name);
  const addressNamed = addressStreet ? units.filter((unit) => unit.street_names.some((name: string) => streetNameKey(name) === addressStreet)) : [];
  const frontageStreet = streetNameKey(feature.tags?.['frontage:street'] || feature.tags?.['driveway:street']);
  const frontageNamed = frontageStreet ? units.filter((unit) => unit.street_names.some((name: string) => streetNameKey(name) === frontageStreet)) : [];
  const drivewayIds = drivewayHint?.unit_ids instanceof Set ? drivewayHint.unit_ids : new Set<string>();
  const drivewayUnits = drivewayIds.size ? units.filter((unit) => drivewayIds.has(unit.unit_id)) : [];
  if (!point) {
    const hierarchy = [
      { units: associated, basis: 'associated_street' },
      { units: addressNamed, basis: 'address_street' },
      { units: frontageNamed, basis: 'frontage_street' },
      { units: drivewayUnits, basis: 'driveway' }
    ].find((candidate) => candidate.units.length);
    const deterministic = hierarchy?.units.sort((left, right) => left.unit_id.localeCompare(right.unit_id));
    return deterministic?.length ? { unit: deterministic[0], distance_meters: null, basis: hierarchy?.basis, resolution: 'deterministic_without_geometry' } : null;
  }
  if (!pointInPolygon(point, units[0]?._polygon || []) && !pointOnPolygonBoundary(point, units[0]?._polygon || [])) return null;
  if (associated.length) return chooseAssociation(point, associated, 'associated_street', 150, true);
  if (addressNamed.length) return chooseAssociation(point, addressNamed, 'address_street', 120);
  if (frontageNamed.length) return chooseAssociation(point, frontageNamed, 'frontage_street', 120);
  if (drivewayUnits.length) return chooseAssociation(point, drivewayUnits, 'driveway', 150, true);
  const fallbackKinds = new Set(['living_street', 'residential', 'road', 'service', 'tertiary', 'unclassified']);
  const fallback = units.filter((unit) => fallbackKinds.has(unit.kind));
  return chooseAssociation(point, fallback, normalized(feature.tags?.entrance) ? 'entrance' : 'bounded_nearest', 75);
}

function classifyAccessEvidence(kind: string, evidence: any[]) {
  const footValues = new Set(evidence.map((item) => normalized(item?.foot)).filter(Boolean));
  const accessValues = new Set(evidence.map((item) => normalized(item?.access)).filter(Boolean));
  const conditional = evidence.some((item) => normalized(item?.['foot:conditional']) || normalized(item?.['access:conditional']));
  const footDenied = [...footValues].some((value) => ['customers', 'no', 'private'].includes(value));
  const footAllowed = [...footValues].some((value) => ['yes', 'designated', 'permissive'].includes(value));
  const accessDenied = [...accessValues].some((value) => ['customers', 'destination', 'no', 'private'].includes(value));
  const accessAllowed = [...accessValues].some((value) => ['yes', 'designated', 'permissive', 'public'].includes(value));
  const lockedBarrier = evidence.some((item) => normalized(item?.locked) === 'yes' && normalized(item?.barrier));
  const uncertainBarrier = evidence.some((item) => ['gate', 'kissing_gate', 'lift_gate', 'swing_gate'].includes(normalized(item?.barrier))
    && normalized(item?.locked) !== 'no');
  if (footDenied || accessDenied || lockedBarrier) return 'restricted';
  if (conditional || uncertainBarrier || footValues.size > 1 || accessValues.size > 1) return 'uncertain';
  if (['motorway', 'motorway_link'].includes(kind)) return 'restricted';
  if (footAllowed || accessAllowed) return 'permitted';
  if (['footway', 'living_street', 'path', 'pedestrian', 'primary', 'residential', 'secondary', 'service', 'steps', 'tertiary', 'track', 'unclassified'].includes(kind)) return 'permitted';
  return 'uncertain';
}

function isCanvasOwnershipWay(element: any) {
  const kind = normalized(element?.tags?.highway);
  if (!['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road'].includes(kind)) return false;
  if (!Array.isArray(element?.nodes) || element.nodes.length < 2 || normalized(element.tags?.barrier)) return false;
  if (kind !== 'service') return true;
  const service = normalized(element.tags?.service).replace(/_/g, '-');
  if (['driveway', 'parking-aisle', 'drive-through', 'emergency-access'].includes(service)) return false;
  const named = Boolean(String(element.tags?.name || '').trim());
  const publicAccess = ['yes', 'public'].includes(normalized(element.tags?.access));
  const motorAccess = normalized(element.tags?.motor_vehicle);
  return named && publicAccess && !['no', 'private', 'customers'].includes(motorAccess);
}

function classifyStreetEvidence(raw: any, polygon: any[], options: any = {}) {
  const includeTilingMetadata = options?.include_tiling_metadata === true;
  const nodes = new Map(raw.elements.filter((element: any) => element.type === 'node'
    && Number.isFinite(element.lat) && Number.isFinite(element.lon))
    .map((node: any) => [node.id, { lat: node.lat, lng: node.lon }]));
  const highwayWays = raw.elements.filter((element: any) => element.type === 'way'
    && element.tags?.highway && Array.isArray(element.nodes));
  const roads = highwayWays.filter(isCanvasOwnershipWay);
  const pedestrianContextWays = highwayWays.filter((element: any) => !isCanvasOwnershipWay(element));
  const units = buildClippedStreetUnits(raw, nodes, roads, polygon);
  if (!units.length) return [];
  const relationHints = associatedStreetHints(raw, units);
  const relationBuildings = relationBuildingGeometries(raw, nodes);
  const drivewayContext = drivewayAssociationContext(pedestrianContextWays, units, nodes);
  const relevantKeys = [
    'building', 'building:use', 'building:units', 'building:flats', 'residential:units', 'units:residential',
    'mixed_use', 'residential', 'landuse', 'natural', 'shop', 'office', 'amenity', 'entrance',
    'addr:housenumber', 'addr:unit', 'addr:street', 'frontage:street', 'driveway:street', 'access', 'foot', 'access:conditional',
    'foot:conditional', 'barrier', 'locked'
  ];
  const features = raw.elements.filter((element: any) => !element.tags?.highway
    && relevantKeys.some((key) => element.tags?.[key] !== undefined)).map((feature: any) => {
      const featureId = `osm_${feature.type}_${feature.id}`;
      const relationGeometry = relationBuildings.geometries.get(featureId) || null;
      const point = featureRepresentativePoint(feature, nodes, polygon, relationGeometry);
      const hint = relationHints.get(featureId);
      const drivewayHint = drivewayHintForFeature(feature, point, drivewayContext);
      const association = associateEvidenceFeature(feature, point, units, hint, drivewayHint);
      return {
        ...feature,
        feature_id: featureId,
        relation_geometry: relationGeometry,
        multipolygon_parent_id: relationBuildings.parent_by_member.get(featureId) || null,
        point,
        address_keys: addressEvidenceKeys(feature, point, hint?.name),
        association: association ? { ...association, association_point: point ? { lat: point.lat, lng: point.lng } : null } : null
      };
    });
  const buildingPolygons = features.filter((feature: any) => ['way', 'relation'].includes(feature.type)
    && normalized(feature.tags?.building)).map((feature: any) => {
      const points = feature.type === 'way' && Array.isArray(feature.nodes)
        ? feature.nodes.map((id: number) => nodes.get(id)).filter(Boolean) : [];
      const geometry = feature.relation_geometry || (points.length >= 3 ? { outer_rings: [points], inner_rings: [] } : null);
      const area = geometry?.outer_rings?.reduce((total: number, ring: any[]) => total + Math.abs(ring.reduce((sum: number, point: any, index: number) => {
        const next = ring[(index + 1) % ring.length];
        return sum + point.lng * next.lat - next.lng * point.lat;
      }, 0)), 0) || Number.POSITIVE_INFINITY;
      return { feature_id: feature.feature_id, geometry, area };
    }).filter((building: any) => building.geometry)
    .sort((left: any, right: any) => left.area - right.area || left.feature_id.localeCompare(right.feature_id));
  const entities = new Map<string, any[]>();
  for (const feature of features) {
    const ownBuildingId = feature.multipolygon_parent_id
      || (['way', 'relation'].includes(feature.type) && normalized(feature.tags?.building) ? feature.feature_id : null);
    const containingBuilding = !ownBuildingId && feature.point ? buildingPolygons.find((building: any) =>
      relationGeometryContains(building.geometry, feature.point)) : null;
    const addressIdentity = feature.address_keys.length ? `address:${feature.address_keys.join('|')}` : null;
    const entityId = ownBuildingId || containingBuilding?.feature_id || addressIdentity || feature.feature_id;
    entities.set(entityId, [...(entities.get(entityId) || []), feature]);
  }
  const opportunityByUnit = new Map<string, any>();
  const claimedAddressesByUnit = new Map<string, Set<string>>();
  const sortedEntities = [...entities.entries()].sort((left, right) => {
    const leftBuilding = left[1].some((feature: any) => ['way', 'relation'].includes(feature.type) && normalized(feature.tags?.building));
    const rightBuilding = right[1].some((feature: any) => ['way', 'relation'].includes(feature.type) && normalized(feature.tags?.building));
    return Number(rightBuilding) - Number(leftBuilding) || left[0].localeCompare(right[0]);
  });
  for (const [entityId, entityFeatures] of sortedEntities) {
    const associations = entityFeatures.map((feature: any) => feature.association).filter(Boolean).sort((left: any, right: any) => {
      const priority: Record<string, number> = {
        associated_street: 0, address_street: 1, frontage_street: 2, driveway: 3, entrance: 4, bounded_nearest: 5
      };
      return (priority[left.basis] ?? 9) - (priority[right.basis] ?? 9)
        || Number(left.distance_meters ?? Number.POSITIVE_INFINITY) - Number(right.distance_meters ?? Number.POSITIVE_INFINITY)
        || left.unit.unit_id.localeCompare(right.unit.unit_id);
    });
    const selected = associations[0];
    if (!selected) continue;
    const signals = entityFeatures.map(featureEvidenceSignals);
    const residential = signals.some((signal: any) => signal.residential);
    const negative = signals.some((signal: any) => signal.negative);
    const ambiguousBuilding = signals.some((signal: any) => signal.ambiguousBuilding);
    const addresses = [...new Set(entityFeatures.flatMap((feature: any) => feature.address_keys))].sort();
    const claimed = claimedAddressesByUnit.get(selected.unit.unit_id) || new Set<string>();
    const unclaimedAddresses = addresses.filter((key) => !claimed.has(key));
    const explicitResidential = entityFeatures.flatMap((feature: any) => [
      positiveInteger(feature.tags?.['residential:units']), positiveInteger(feature.tags?.['units:residential'])
    ]).filter(Boolean) as number[];
    const explicitGeneric = entityFeatures.flatMap((feature: any) => [
      positiveInteger(feature.tags?.['building:units']), positiveInteger(feature.tags?.['building:flats'])
    ]).filter(Boolean) as number[];
    const entranceKeys = new Set(entityFeatures.filter((feature: any) => normalized(feature.tags?.entrance)
      && !featureEvidenceSignals(feature).serviceEntrance && !featureEvidenceSignals(feature).negative)
      .map((feature: any) => feature.address_keys[0]
        || (feature.point ? `${feature.point.lat.toFixed(7)},${feature.point.lng.toFixed(7)}` : feature.feature_id)));
    let contribution = { low: 0, expected: 0, high: 0, source: 'none', confidence: 'uncertain' };
    if (explicitResidential.length) {
      const count = Math.max(...explicitResidential);
      contribution = { low: count, expected: count, high: count, source: 'explicit_residential_units', confidence: 'high' };
    } else if (explicitGeneric.length && (residential || (!negative && !ambiguousBuilding))) {
      const count = Math.max(...explicitGeneric);
      contribution = { low: count, expected: count, high: count, source: 'explicit_building_units', confidence: 'high' };
    } else if (unclaimedAddresses.length && (residential || (!negative && !ambiguousBuilding))) {
      contribution = {
        low: unclaimedAddresses.length,
        expected: unclaimedAddresses.length,
        high: unclaimedAddresses.length,
        source: 'deduplicated_addresses',
        confidence: 'high'
      };
    } else if (signals.some((signal: any) => signal.multiUnit) && residential) {
      contribution = {
        low: Math.max(2, entranceKeys.size),
        expected: Math.max(8, entranceKeys.size * 2),
        high: Math.max(30, entranceKeys.size * 4),
        source: 'multi_unit_proxy',
        confidence: 'low'
      };
    } else if (signals.some((signal: any) => signal.residentialBuilding)) {
      contribution = { low: 1, expected: 1, high: 1, source: 'residential_footprint', confidence: 'low' };
    }
    if (contribution.expected > 0) {
      for (const key of addresses) claimed.add(key);
      claimedAddressesByUnit.set(selected.unit.unit_id, claimed);
    }
    const aggregate = opportunityByUnit.get(selected.unit.unit_id) || {
      low: 0, expected: 0, high: 0, sources: new Set<string>(), features: new Map<string, any>(),
      residential: false, ambiguous: false, negative: false, openLand: false
    };
    aggregate.residential ||= residential;
    aggregate.ambiguous ||= ambiguousBuilding;
    aggregate.negative ||= negative;
    aggregate.openLand ||= signals.some((signal: any) => signal.openLand);
    if (contribution.expected > 0) {
      aggregate.low += contribution.low;
      aggregate.expected += contribution.expected;
      aggregate.high += contribution.high;
      aggregate.sources.add(contribution.source);
      aggregate.features.set(entityId, {
        feature_id: entityId,
        associated_unit_id: selected.unit.unit_id,
        association_distance_meters: selected.distance_meters,
        association_basis: selected.basis,
        association_resolution: selected.resolution || null,
        association_point: selected.association_point || null,
        low: contribution.low,
        expected: contribution.expected,
        high: contribution.high,
        source: contribution.source
      });
    }
    opportunityByUnit.set(selected.unit.unit_id, aggregate);
  }
  const accessEvidenceByUnit = new Map(units.map((unit: any) => [unit.unit_id, [unit._road_tags]]));
  for (const feature of features) {
    if (!feature.association || !['access', 'foot', 'access:conditional', 'foot:conditional', 'barrier', 'locked']
      .some((key) => feature.tags?.[key] !== undefined)) continue;
    accessEvidenceByUnit.get(feature.association.unit.unit_id)?.push(feature.tags || {});
  }
  for (const contextWay of pedestrianContextWays) {
    if (!['access', 'foot', 'access:conditional', 'foot:conditional', 'barrier', 'locked']
      .some((key) => contextWay.tags?.[key] !== undefined)) continue;
    const point = featureRepresentativePoint(contextWay, nodes, polygon);
    const contextDriveway = drivewayContext.find((record) => record.way_id === contextWay.id);
    const association = associateEvidenceFeature(contextWay, point, units, null,
      contextDriveway ? { unit_ids: contextDriveway.unit_ids, basis: 'driveway' } : null);
    if (association) accessEvidenceByUnit.get(association.unit.unit_id)?.push(contextWay.tags || {});
  }
  return units.map((unit: any) => {
    const evidence = opportunityByUnit.get(unit.unit_id);
    const opportunity = evidence?.expected > 0 ? 'likely'
      : evidence?.residential || evidence?.ambiguous ? 'uncertain'
        : evidence?.negative || evidence?.openLand ? 'none' : 'uncertain';
    const access = classifyAccessEvidence(unit.kind, accessEvidenceByUnit.get(unit.unit_id) || [unit._road_tags]);
    const canvasRole = access === 'restricted' ? 'excluded'
      : opportunity === 'likely' && access === 'permitted' ? 'knock'
        : opportunity === 'none' && access === 'permitted' && TRANSIT_HIGHWAYS.has(unit.kind) ? 'transit_only'
          : opportunity === 'none' && access !== 'uncertain' ? 'excluded' : 'uncertain';
    const sources = evidence ? [...evidence.sources].sort() : [];
    const opportunityFeatures = evidence ? [...evidence.features.values()]
      .sort((left: any, right: any) => left.feature_id.localeCompare(right.feature_id)) : [];
    const { _road_id, _road_tags, _source_node_ids, _first_node_id, _last_node_id, _polygon, ...publicUnit } = unit;
    const {
      source_way_id, source_edge_ids, protected_origin_node_ids, explicit_protected_origin_node_ids,
      segments, ...ordinaryUnit
    } = publicUnit;
    const ordinarySegments = segments.map((segment: any) => {
      if (includeTilingMetadata) return segment;
      const {
        source_edge_id, source_way_id: segmentSourceWayId, source_edge_index, source_from, source_to,
        source_start_node_id, source_end_node_id, source_edge_start_node_id, source_edge_end_node_id,
        boundary_start, boundary_end, protected_origin_node_ids: segmentProtectedOrigins,
        explicit_protected_origin_node_ids: segmentExplicitOrigins, ...ordinarySegment
      } = segment;
      return ordinarySegment;
    });
    return {
      ...ordinaryUnit,
      ...(includeTilingMetadata ? {
        source_way_id,
        source_edge_ids,
        protected_origin_node_ids,
        explicit_protected_origin_node_ids
      } : {}),
      segments: ordinarySegments,
      canvas_role: canvasRole,
      opportunity_classification: opportunity,
      access_classification: access,
      opportunity_low: Number(evidence?.low || 0),
      opportunity_expected: Number(evidence?.expected || 0),
      opportunity_high: Number(evidence?.high || 0),
      opportunity_source: sources.join('+') || 'none',
      opportunity_features: opportunityFeatures,
      confidence: sources.some((source) => ['explicit_residential_units', 'explicit_building_units', 'deduplicated_addresses'].includes(source))
        ? 'high' : opportunityFeatures.length ? 'medium' : 'uncertain'
    };
  });
}

function asArray(value: any) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function mutationCommitted(mutation: any, expected = 1) {
  return mutation?.success === true && Number(mutation?.updated) === expected && mutation?.has_more !== true;
}

function randomToken(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireAnalysisIdentityLease(base44: any, managerId: string) {
  const deadline = Date.now() + ANALYSIS_IDENTITY_LEASE_WAIT_MS;
  do {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const token = randomToken('canvas_analysis_identity');
    const expiresAt = new Date(now + ANALYSIS_IDENTITY_LEASE_MS).toISOString();
    const mutation = await base44.asServiceRole.entities.User.updateMany({
      id: managerId,
      $or: [
        { canvas_analysis_identity_lock_token: '' },
        { canvas_analysis_identity_lock_token: null },
        { canvas_analysis_identity_lock_token: { $exists: false } },
        { canvas_analysis_identity_lock_expires_at: { $lte: nowIso } }
      ]
    }, { $set: {
      canvas_analysis_identity_lock_token: token,
      canvas_analysis_identity_lock_acquired_at: nowIso,
      canvas_analysis_identity_lock_expires_at: expiresAt
    } });
    if (mutationCommitted(mutation)) {
      const lockedUser = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
      if (!lockedUser || String(lockedUser.canvas_analysis_identity_lock_token || '') !== token
        || String(lockedUser.canvas_analysis_identity_lock_expires_at || '') !== expiresAt) {
        throw new HttpError(503, 'canvas_analysis_identity_lease_unverified', 'Canvas could not verify its tenant identity lease. No identity was committed.');
      }
      return { token };
    }
    if (Date.now() >= deadline) break;
    await sleep(50);
  } while (Date.now() <= deadline);
  throw new HttpError(409, 'canvas_analysis_identity_in_progress', 'Another Canvas analysis identity is committing for this manager. Retry in a moment.');
}

async function releaseAnalysisIdentityLease(base44: any, managerId: string, lease: any) {
  if (!lease) return;
  await base44.asServiceRole.entities.User.updateMany({
    id: managerId,
    canvas_analysis_identity_lock_token: lease.token
  }, { $unset: {
    canvas_analysis_identity_lock_token: '',
    canvas_analysis_identity_lock_acquired_at: '',
    canvas_analysis_identity_lock_expires_at: ''
  } }).catch(() => null);
}

function analysisCacheEpoch() {
  const configured = Number(Deno.env.get('CANVAS_ANALYSIS_CACHE_TTL_MS'));
  const ttl = Number.isFinite(configured) && configured >= 60 * 60 * 1_000 && configured <= 7 * 24 * 60 * 60 * 1_000
    ? configured
    : DEFAULT_ANALYSIS_CACHE_TTL_MS;
  return Math.floor(Date.now() / ttl);
}

async function loadAnalysisJob(base44: any, jobId: string) {
  const jobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId }, null, 2, 0));
  if (jobs.length !== 1 || jobs[0].job_id !== jobId) throw new HttpError(404, 'canvas_analysis_job_not_found', 'The large Canvas analysis job was not found.');
  return jobs[0];
}

async function kickLargeAnalysisProcessor(base44: any, job: any) {
  if (!job?.job_id || !job?.processor_token || !['queued', 'running', 'finalizing'].includes(job.status)) return;
  const invocation = base44.asServiceRole.functions.invoke('canvasStartAnalysis', {
    internal_action: 'process_large_analysis_job',
    job_id: job.job_id,
    processor_token: job.processor_token
  }).catch((error: any) => console.warn(`[canvasStartAnalysis] processor kick failed for ${job.job_id}: ${error?.message || error}`));
  await Promise.race([invocation, sleep(500)]);
}

async function acquireAnalysisLease(base44: any, job: any, processorToken: string) {
  const suppliedHash = await sha256({ job_id: job.job_id, processor_token: processorToken });
  if (!job.processor_token_hash || suppliedHash !== job.processor_token_hash) throw new HttpError(403, 'canvas_analysis_processor_unauthorized', 'The large-area processor capability is invalid.');
  if (!['queued', 'running', 'finalizing'].includes(job.status)) return null;
  const now = new Date();
  const lockToken = randomToken('canvas_analysis_lease');
  const expiresAt = new Date(now.getTime() + ANALYSIS_LEASE_MS).toISOString();
  const expectedVersion = Number(job.version || 0);
  const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
    id: job.id,
    job_id: job.job_id,
    manager_id: job.manager_id,
    version: expectedVersion,
    status: { $in: ['queued', 'running', 'finalizing'] },
    $or: [
      { lock_token: '' },
      { lock_token: null },
      { lock_token: { $exists: false } },
      { lock_expires_at: { $lte: now.toISOString() } }
    ]
  }, { $set: {
    status: job.status === 'finalizing' ? 'finalizing' : 'running',
    version: expectedVersion + 1,
    lock_token: lockToken,
    lock_acquired_at: now.toISOString(),
    lock_expires_at: expiresAt,
    last_processor_kick_at: now.toISOString(),
    updated_at: now.toISOString()
  } });
  if (!mutationCommitted(mutation)) return null;
  const locked = await loadAnalysisJob(base44, job.job_id);
  if (locked.lock_token !== lockToken || Number(locked.version) !== expectedVersion + 1 || locked.manager_id !== job.manager_id) {
    throw new HttpError(503, 'canvas_analysis_lease_unverified', 'Canvas could not verify the large-area processor lease.');
  }
  return locked;
}

async function releaseAnalysisLease(base44: any, job: any, patch: any = {}) {
  const expectedVersion = Number(job.version || 0);
  const updatedAt = new Date().toISOString();
  const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
    id: job.id,
    job_id: job.job_id,
    manager_id: job.manager_id,
    version: expectedVersion,
    lock_token: job.lock_token
  }, { $set: {
    ...patch,
    version: expectedVersion + 1,
    updated_at: updatedAt
  }, $unset: { lock_token: '', lock_acquired_at: '', lock_expires_at: '' } });
  if (!mutationCommitted(mutation)) throw new HttpError(409, 'canvas_analysis_progress_conflict', 'Large Canvas analysis progress changed before it could be committed.');
  return loadAnalysisJob(base44, job.job_id);
}

const SOURCE_FRACTION_EPSILON = 1e-8;

function sourceEdgeIdentity(segment: any, unit: any) {
  const candidates = [segment?.source_edge_id, ...asArray(unit?.source_edge_ids), segment?.edge_id]
    .map((value) => String(value || '').trim()).filter(Boolean);
  for (const candidate of candidates) {
    const match = candidate.match(/^osm_way_(\d+)_(\d+)(?:_([0-9a-z]+)_([0-9a-z]+))?$/i);
    if (!match) continue;
    const sourceWayId = Number(segment?.source_way_id ?? unit?.source_way_id ?? match[1]);
    const sourceEdgeIndex = Number(segment?.source_edge_index ?? match[2]);
    if (!Number.isSafeInteger(sourceWayId) || sourceWayId <= 0 || !Number.isSafeInteger(sourceEdgeIndex) || sourceEdgeIndex < 0) continue;
    const decodedFrom = match[3] ? Number.parseInt(match[3], 36) / 1_000_000_000 : 0;
    const decodedTo = match[4] ? Number.parseInt(match[4], 36) / 1_000_000_000 : 1;
    const sourceFrom = Number.isFinite(Number(segment?.source_from)) ? Number(segment.source_from) : decodedFrom;
    const sourceTo = Number.isFinite(Number(segment?.source_to)) ? Number(segment.source_to) : decodedTo;
    if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)
      || sourceFrom < -SOURCE_FRACTION_EPSILON || sourceTo > 1 + SOURCE_FRACTION_EPSILON
      || sourceTo - sourceFrom <= SOURCE_FRACTION_EPSILON) continue;
    return {
      source_edge_id: `osm_way_${sourceWayId}_${sourceEdgeIndex}`,
      source_way_id: sourceWayId,
      source_edge_index: sourceEdgeIndex,
      source_from: Math.max(0, sourceFrom),
      source_to: Math.min(1, sourceTo)
    };
  }
  return null;
}

function clipSourceSegmentToPolygon(segment: any, polygon: any[]) {
  if (!segment?.start || !segment?.end || !Array.isArray(polygon) || polygon.length < 3) return [];
  const sourceFrom = Number(segment.source_from);
  const sourceTo = Number(segment.source_to);
  if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo) || sourceTo - sourceFrom <= SOURCE_FRACTION_EPSILON) return [];
  return clipRoadEdgeToPolygon(segment.start, segment.end, polygon, Number(segment.source_way_id || 0), Number(segment.source_edge_index || 0))
    .map((interval: any) => {
      const mappedFrom = sourceFrom + (sourceTo - sourceFrom) * interval.from;
      const mappedTo = sourceFrom + (sourceTo - sourceFrom) * interval.to;
      return {
        ...segment,
        start: interval.start,
        end: interval.end,
        source_from: Number(mappedFrom.toFixed(10)),
        source_to: Number(mappedTo.toFixed(10)),
        source_start_node_id: interval.start_original ? segment.source_start_node_id ?? null : null,
        source_end_node_id: interval.end_original ? segment.source_end_node_id ?? null : null,
        boundary_start: segment.boundary_start === true || !interval.start_original,
        boundary_end: segment.boundary_end === true || !interval.end_original,
        length_meters: Number(distanceMeters(interval.start, interval.end).toFixed(2))
      };
    }).filter((fragment: any) => fragment.source_to - fragment.source_from > SOURCE_FRACTION_EPSILON
      && Number(fragment.length_meters) > 0.01);
}

function ownedFragmentId(sourceEdgeId: string, sourceFrom: number, sourceTo: number) {
  return `${sourceEdgeId}_${fractionToken(sourceFrom)}_${fractionToken(sourceTo)}`;
}

function clipClassifiedStreetUnitsToOwnedCore(streetUnits: any[], corePolygon: any[], managerPolygon: any[]) {
  const fragments: any[] = [];
  for (const unit of asArray(streetUnits)) {
    const ownedOpportunityFeatures = asArray(unit?.opportunity_features).filter((feature: any) => {
      const point = feature?.association_point;
      if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return true;
      return (pointInPolygon(point, corePolygon) || pointOnPolygonBoundary(point, corePolygon))
        && (pointInPolygon(point, managerPolygon) || pointOnPolygonBoundary(point, managerPolygon));
    });
    const unitOriginIds = new Set(asArray(unit?.explicit_protected_origin_node_ids)
      .map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0));
    for (const rawSegment of asArray(unit?.segments)) {
      const identity = sourceEdgeIdentity(rawSegment, unit);
      if (!identity || !rawSegment?.start || !rawSegment?.end) continue;
      const sourceSegment = { ...rawSegment, ...identity };
      const ownedPieces = clipSourceSegmentToPolygon(sourceSegment, corePolygon)
        .flatMap((fragment: any) => clipSourceSegmentToPolygon(fragment, managerPolygon));
      for (const segment of ownedPieces) {
        const fragmentId = ownedFragmentId(identity.source_edge_id, segment.source_from, segment.source_to);
        const relevantOriginIds = [...unitOriginIds].filter((nodeId) =>
          Number(segment.source_start_node_id) === nodeId || Number(segment.source_end_node_id) === nodeId).sort((left, right) => left - right);
        const singleEdgeWay = String(unit?.unit_id || unit?.id || '') === `osm_way_${identity.source_way_id}`
          && asArray(unit?.source_edge_ids).length <= 1;
        const {
          protected_group_id: _protectedGroupId,
          protected_group_ids: _protectedGroupIds,
          neighbor_ids: _neighborIds,
          segments: _segments,
          protected_origin_node_ids: _tileProtectedOriginNodeIds,
          explicit_protected_origin_node_ids: _explicitProtectedOriginNodeIds,
          id: _id,
          unit_id: _unitId,
          ...classification
        } = unit || {};
        const { protected_origin_node_ids: _segmentTileOrigins, ...ownedSegment } = segment;
        fragments.push({
          ...classification,
          id: fragmentId,
          unit_id: fragmentId,
          source_edge_ids: [identity.source_edge_id],
          source_way_id: identity.source_way_id,
          protected: false,
          explicit_protected_origin_node_ids: relevantOriginIds,
          opportunity_features: ownedOpportunityFeatures,
          source_single_edge_way: singleEdgeWay,
          neighbor_ids: [],
          street_length_meters: Number(segment.length_meters || 0),
          segments: [{
            ...ownedSegment,
            edge_id: fragmentId,
            source_edge_id: identity.source_edge_id,
            source_way_id: identity.source_way_id,
            source_edge_index: identity.source_edge_index
          }]
        });
      }
    }
  }
  const deduplicated = new Map<string, any>();
  for (const fragment of fragments.sort((left, right) => left.unit_id.localeCompare(right.unit_id))) {
    if (!deduplicated.has(fragment.unit_id)) deduplicated.set(fragment.unit_id, fragment);
  }
  return [...deduplicated.values()];
}

async function persistImmutableTileEvidence(base44: any, job: any, tile: any, endpoint: any, rawEvidence: any, resultBytes: number) {
  const content = {
    schema_version: 1,
    manager_id: job.manager_id,
    job_id: job.job_id,
    tile_id: tile.tile_id,
    tile_index: Number(tile.tile_index),
    provider: endpoint.provider,
    source_version: rawEvidence.osm_base,
    extraction_version: job.extraction_version,
    query_polygon: tile.query_polygon,
    raw_evidence: rawEvidence
  };
  const evidenceBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  if (evidenceBytes > MAX_SNAPSHOT_BYTES) throw new HttpError(413, 'canvas_tile_evidence_too_large', 'A normalized large-area tile exceeds the safe immutable evidence payload limit.');
  const tileEvidenceHash = await sha256(content);
  const tileEvidenceId = `canvas_tile_evidence_${tileEvidenceHash}`;
  const jobEvidence = asArray(await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.filter({ job_id: job.job_id, manager_id: job.manager_id }, null, MAX_LARGE_TILE_EVIDENCE_RECORDS + 1, 0));
  if (jobEvidence.length > MAX_LARGE_TILE_EVIDENCE_RECORDS) throw new HttpError(409, 'canvas_intermediate_storage_ambiguous', 'Large-area raw evidence contains more retry records than its bounded tile manifest permits.');
  let existing = jobEvidence.filter((row: any) => row.tile_evidence_id === tileEvidenceId);
  const persistedRawBytes = jobEvidence.reduce((sum: number, row: any) => {
    const recorded = Number(row.evidence_bytes);
    return sum + (Number.isSafeInteger(recorded) && recorded > 0
      ? recorded
      : new TextEncoder().encode(JSON.stringify(row)).byteLength);
  }, 0);
  const completedTiles = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: job.job_id, manager_id: job.manager_id, status: 'complete' }, null, MAX_LARGE_TILE_COUNT + 1, 0));
  const persistedResultBytes = completedTiles.reduce((sum: number, row: any) => sum + Number(row.analysis_result_bytes || 0), 0);
  const nextRawBytes = persistedRawBytes + (existing.length ? 0 : evidenceBytes);
  const nextResultBytes = persistedResultBytes + resultBytes;
  if (nextRawBytes > MAX_LARGE_JOB_RAW_EVIDENCE_BYTES
    || nextResultBytes > MAX_LARGE_JOB_RESULT_BYTES
    || nextRawBytes + nextResultBytes > MAX_LARGE_JOB_INTERMEDIATE_BYTES) {
    throw new HttpError(413, 'canvas_analysis_intermediate_storage_limit', 'The large-area analysis exceeded its cumulative intermediate storage budget. Split this unusually dense boundary.');
  }
  if (!existing.length) {
    await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.create({
      ...content,
      tile_evidence_id: tileEvidenceId,
      tile_evidence_hash: tileEvidenceHash,
      evidence_bytes: evidenceBytes,
      created_at: new Date().toISOString()
    });
    existing = asArray(await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.filter({ tile_evidence_id: tileEvidenceId, manager_id: job.manager_id }, null, 2, 0));
  }
  if (existing.length !== 1 || existing[0].tile_evidence_hash !== tileEvidenceHash || existing[0].job_id !== job.job_id || existing[0].tile_id !== tile.tile_id) {
    throw new HttpError(409, 'canvas_tile_evidence_collision', 'An immutable large-area tile evidence identity collision was detected.');
  }
  return {
    tile_evidence_id: tileEvidenceId,
    tile_evidence_hash: tileEvidenceHash,
    raw_evidence_bytes: evidenceBytes,
    cumulative_raw_evidence_bytes: nextRawBytes,
    cumulative_analysis_result_bytes: nextResultBytes
  };
}

async function fetchAndClassifyTile(base44: any, job: any, tile: any) {
  const endpoint = largeAreaOverpassEndpoint();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LARGE_TILE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: providerHeaders(),
      body: new URLSearchParams({ data: overpassQuery(tile.query_polygon, 22) }),
      signal: controller.signal
    });
    const { payload, bytes, element_count: elementCount } = await readBoundedTileJson(response);
    const rawEvidence = normalizedRawEvidence(payload);
    const contextStreetUnits = classifyStreetEvidence(rawEvidence, tile.query_polygon, { include_tiling_metadata: true });
    const streetUnits = clipClassifiedStreetUnitsToOwnedCore(contextStreetUnits, tile.core_polygon, job.polygon);
    const analysisResult = {
      territory_model: 'residential_street_territory_v2',
      street_units: streetUnits,
      classifier_version: job.classifier_version
    };
    const resultBytes = new TextEncoder().encode(JSON.stringify(analysisResult)).byteLength;
    if (resultBytes > LARGE_TILE_RESULT_BYTES) throw new HttpError(413, 'canvas_tile_result_too_large', 'A classified large-area tile exceeds the safe result payload limit. Split this unusually dense boundary.');
    const immutable = await persistImmutableTileEvidence(base44, job, tile, endpoint, rawEvidence, resultBytes);
    return {
      endpoint,
      source_version: rawEvidence.osm_base,
      response_bytes: bytes,
      element_count: elementCount,
      analysis_result: analysisResult,
      analysis_result_hash: await sha256(analysisResult),
      analysis_result_bytes: resultBytes,
      ...immutable
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new HttpError(504, 'canvas_tile_timeout', 'A large-area OSM tile timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function compactTerminalAnalysisIntermediates(base44: any, terminalJob: any) {
  if (!terminalJob?.job_id || !['complete', 'failed', 'cancelled'].includes(terminalJob.status)) return terminalJob;
  if (terminalJob.intermediate_storage_compacted_at
    && Number(terminalJob.raw_evidence_bytes || 0) === 0
    && Number(terminalJob.analysis_result_bytes || 0) === 0) return terminalJob;
  const managerId = String(terminalJob.manager_id || '');
  const evidenceRows = asArray(await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.filter({
    job_id: terminalJob.job_id,
    manager_id: managerId
  }, null, MAX_LARGE_TILE_EVIDENCE_RECORDS + 1, 0));
  const tileRows = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({
    job_id: terminalJob.job_id,
    manager_id: managerId
  }, null, MAX_LARGE_TILE_COUNT + 1, 0));
  if (evidenceRows.length > MAX_LARGE_TILE_EVIDENCE_RECORDS || tileRows.length > MAX_LARGE_TILE_COUNT) {
    throw new HttpError(409, 'canvas_intermediate_storage_ambiguous', 'Canvas refused to compact an intermediate set outside its bounded job manifest.');
  }
  for (const row of evidenceRows) await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.delete(row.id);
  for (const row of tileRows) await base44.asServiceRole.entities.CanvasAnalysisTile.delete(row.id);
  const [remainingEvidence, remainingTiles] = await Promise.all([
    base44.asServiceRole.entities.CanvasAnalysisTileEvidence.filter({ job_id: terminalJob.job_id, manager_id: managerId }, null, 1, 0),
    base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: terminalJob.job_id, manager_id: managerId }, null, 1, 0)
  ]);
  if (asArray(remainingEvidence).length || asArray(remainingTiles).length) {
    throw new HttpError(503, 'canvas_intermediate_compaction_unverified', 'Canvas could not verify terminal intermediate compaction. The final evidence snapshot remains intact.');
  }
  const latest = await loadAnalysisJob(base44, terminalJob.job_id);
  if (!['complete', 'failed', 'cancelled'].includes(latest.status)) return latest;
  const compactedAt = new Date().toISOString();
  const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
    id: latest.id,
    job_id: latest.job_id,
    manager_id: managerId,
    status: latest.status,
    version: Number(latest.version || 0)
  }, { $set: {
    version: Number(latest.version || 0) + 1,
    raw_evidence_bytes: 0,
    analysis_result_bytes: 0,
    intermediate_storage_compacted_at: compactedAt,
    intermediate_storage_policy: INTERMEDIATE_STORAGE_POLICY,
    updated_at: compactedAt
  } });
  if (!mutationCommitted(mutation)) throw new HttpError(409, 'canvas_intermediate_compaction_conflict', 'The terminal analysis changed before compaction metadata committed.');
  return loadAnalysisJob(base44, terminalJob.job_id);
}

function topologyEndpoint(segment: any, atStart: boolean) {
  const point = atStart ? segment.start : segment.end;
  const sourceNodeId = Number(atStart ? segment.source_start_node_id : segment.source_end_node_id);
  const nodeId = Number.isSafeInteger(sourceNodeId) && sourceNodeId > 0 ? sourceNodeId : null;
  const coordinateKey = point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
    ? `${Number(point.lat).toFixed(7)}:${Number(point.lng).toFixed(7)}` : '';
  return { point, node_id: nodeId, key: nodeId ? `osm_node_${nodeId}` : `coordinate_${coordinateKey}` };
}

function mergeOwnedSourceFragments(fragments: any[]) {
  const sorted = fragments.filter((segment) => Number.isFinite(Number(segment?.source_from))
    && Number.isFinite(Number(segment?.source_to)) && segment?.start && segment?.end)
    .sort((left, right) => Number(left.source_from) - Number(right.source_from)
      || Number(left.source_to) - Number(right.source_to)
      || String(left.edge_id || '').localeCompare(String(right.edge_id || '')));
  const merged: any[] = [];
  for (const candidate of sorted) {
    const fragment = structuredClone(candidate);
    const previous = merged.at(-1);
    if (!previous || Number(fragment.source_from) > Number(previous.source_to) + SOURCE_FRACTION_EPSILON) {
      merged.push(fragment);
      continue;
    }
    if (Number(fragment.source_to) > Number(previous.source_to) + SOURCE_FRACTION_EPSILON) {
      previous.source_to = fragment.source_to;
      previous.end = fragment.end;
      previous.source_end_node_id = fragment.source_end_node_id ?? null;
      previous.boundary_end = fragment.boundary_end === true;
    }
    previous.length_meters = Number(distanceMeters(previous.start, previous.end).toFixed(2));
  }
  return merged;
}

function addBestOpportunityFeature(target: Map<string, any>, feature: any) {
  const featureId = String(feature?.feature_id || '').trim();
  if (!featureId) return;
  const existing = target.get(featureId);
  const distance = Number.isFinite(Number(feature?.association_distance_meters))
    ? Number(feature.association_distance_meters) : Number.POSITIVE_INFINITY;
  const existingDistance = Number.isFinite(Number(existing?.association_distance_meters))
    ? Number(existing.association_distance_meters) : Number.POSITIVE_INFINITY;
  if (!existing || distance < existingDistance) target.set(featureId, feature);
}

function mergeStreetUnitResults(tiles: any[], managerPolygon: any[]) {
  const sourceEdges = new Map<string, any>();
  for (const tile of [...tiles].sort((left, right) => Number(left.tile_index) - Number(right.tile_index))) {
    for (const unit of asArray(tile?.analysis_result?.street_units)) {
      for (const segment of asArray(unit?.segments)) {
        const identity = sourceEdgeIdentity(segment, unit);
        if (!identity) continue;
        let aggregate = sourceEdges.get(identity.source_edge_id);
        if (!aggregate) {
          aggregate = {
            ...identity,
            kinds: new Set<string>(),
            street_names: new Set<string>(),
            fragments: [],
            opportunity_features: new Map<string, any>(),
            opportunity_states: new Set<string>(),
            access_states: new Set<string>(),
            explicit_protected_origin_node_ids: new Set<number>(),
            source_single_edge_way: false
          };
          sourceEdges.set(identity.source_edge_id, aggregate);
        }
        aggregate.fragments.push({ ...segment, ...identity });
        if (String(unit?.kind || '').trim()) aggregate.kinds.add(String(unit.kind));
        for (const name of asArray(unit?.street_names)) if (String(name || '').trim()) aggregate.street_names.add(String(name));
        for (const feature of asArray(unit?.opportunity_features)) addBestOpportunityFeature(aggregate.opportunity_features, feature);
        aggregate.opportunity_states.add(String(unit?.opportunity_classification || 'uncertain'));
        aggregate.access_states.add(String(unit?.access_classification || 'uncertain'));
        for (const nodeId of asArray(unit?.explicit_protected_origin_node_ids).map(Number)) {
          if ((Number(segment.source_start_node_id) === nodeId || Number(segment.source_end_node_id) === nodeId)
            && Number.isSafeInteger(nodeId) && nodeId > 0) aggregate.explicit_protected_origin_node_ids.add(nodeId);
        }
        aggregate.source_single_edge_way ||= unit?.source_single_edge_way === true;
      }
    }
  }

  const edgeUnits: any[] = [];
  for (const aggregate of [...sourceEdges.values()].sort((left, right) => left.source_edge_id.localeCompare(right.source_edge_id))) {
    for (const segment of mergeOwnedSourceFragments(aggregate.fragments)) {
      const fullSourceEdge = Number(segment.source_from) <= SOURCE_FRACTION_EPSILON
        && Number(segment.source_to) >= 1 - SOURCE_FRACTION_EPSILON;
      const edgeId = fullSourceEdge ? aggregate.source_edge_id
        : ownedFragmentId(aggregate.source_edge_id, Number(segment.source_from), Number(segment.source_to));
      edgeUnits.push({
        id: edgeId,
        unit_id: edgeId,
        source_edge_ids: [aggregate.source_edge_id],
        source_way_id: aggregate.source_way_id,
        source_edge_index: aggregate.source_edge_index,
        source_single_edge_way: aggregate.source_single_edge_way,
        kinds: aggregate.kinds,
        street_names: aggregate.street_names,
        opportunity_features: aggregate.opportunity_features,
        opportunity_states: aggregate.opportunity_states,
        access_states: aggregate.access_states,
        explicit_protected_origin_node_ids: aggregate.explicit_protected_origin_node_ids,
        segments: [{ ...segment, edge_id: edgeId, source_edge_id: aggregate.source_edge_id }]
      });
    }
  }
  if (!edgeUnits.length) return [];

  const edgeById = new Map(edgeUnits.map((unit) => [unit.unit_id, unit]));
  const edgeIncidences = new Map<string, any[]>();
  const explicitOriginKeys = new Set<string>();
  for (const unit of edgeUnits) {
    const segment = unit.segments[0];
    unit._start = topologyEndpoint(segment, true);
    unit._end = topologyEndpoint(segment, false);
    for (const endpoint of [unit._start, unit._end]) {
      if (!edgeIncidences.has(endpoint.key)) edgeIncidences.set(endpoint.key, []);
      edgeIncidences.get(endpoint.key)?.push({ unit_id: unit.unit_id, endpoint });
      if (endpoint.node_id && unit.explicit_protected_origin_node_ids.has(endpoint.node_id)) explicitOriginKeys.add(endpoint.key);
    }
  }
  const parent = new Map(edgeUnits.map((unit) => [unit.unit_id, unit.unit_id]));
  const find = (unitId: string): string => {
    const current = parent.get(unitId) || unitId;
    if (current === unitId) return current;
    const root = find(current);
    parent.set(unitId, root);
    return root;
  };
  const join = (leftId: string, rightId: string) => {
    const leftRoot = find(leftId);
    const rightRoot = find(rightId);
    if (leftRoot === rightRoot) return;
    if (leftRoot.localeCompare(rightRoot) < 0) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };
  for (const [endpointKey, incidences] of edgeIncidences) {
    if (incidences.length !== 2 || explicitOriginKeys.has(endpointKey)) continue;
    const left = edgeById.get(incidences[0].unit_id);
    const right = edgeById.get(incidences[1].unit_id);
    if (!left || !right || left.unit_id === right.unit_id || left.source_way_id !== right.source_way_id
      || Math.abs(Number(left.source_edge_index) - Number(right.source_edge_index)) !== 1) continue;
    join(left.unit_id, right.unit_id);
  }
  const components = new Map<string, any[]>();
  for (const unit of edgeUnits) {
    const root = find(unit.unit_id);
    components.set(root, [...(components.get(root) || []), unit]);
  }

  const blocks: any[] = [];
  for (const members of components.values()) {
    const orderedMembers = [...members].sort((left, right) => Number(left.source_edge_index) - Number(right.source_edge_index)
      || Number(left.segments[0].source_from) - Number(right.segments[0].source_from)
      || left.unit_id.localeCompare(right.unit_id));
    const first = orderedMembers[0];
    const last = orderedMembers.at(-1);
    const segments = orderedMembers.flatMap((member) => member.segments);
    const singleLegacyEdge = orderedMembers.length === 1 && first.source_single_edge_way
      && Number(first.segments[0].source_from) <= SOURCE_FRACTION_EPSILON
      && Number(first.segments[0].source_to) >= 1 - SOURCE_FRACTION_EPSILON;
    const blockId = singleLegacyEdge ? `osm_way_${first.source_way_id}`
      : `osm_block_${first.source_way_id}_${first.source_edge_index}_${fractionToken(Number(first.segments[0].source_from))}`
        + `_${last.source_edge_index}_${fractionToken(Number(last.segments[0].source_to))}`;
    const block = {
      id: blockId,
      unit_id: blockId,
      source_way_id: first.source_way_id,
      source_edge_ids: [...new Set(orderedMembers.flatMap((member) => member.source_edge_ids))].sort(),
      kinds: new Set<string>(),
      street_names: new Set<string>(),
      opportunity_features: new Map<string, any>(),
      opportunity_states: new Set<string>(),
      access_states: new Set<string>(),
      explicit_protected_origin_node_ids: new Set<number>(),
      segments,
      _start: topologyEndpoint(segments[0], true),
      _end: topologyEndpoint(segments.at(-1), false)
    };
    for (const member of orderedMembers) {
      for (const value of member.kinds) block.kinds.add(value);
      for (const value of member.street_names) block.street_names.add(value);
      for (const feature of member.opportunity_features.values()) addBestOpportunityFeature(block.opportunity_features, feature);
      for (const value of member.opportunity_states) block.opportunity_states.add(value);
      for (const value of member.access_states) block.access_states.add(value);
      for (const value of member.explicit_protected_origin_node_ids) block.explicit_protected_origin_node_ids.add(value);
    }
    blocks.push(block);
  }

  const blockById = new Map(blocks.map((block) => [block.unit_id, block]));
  const blockIncidences = new Map<string, any[]>();
  for (const block of blocks) {
    for (const endpoint of [block._start, block._end]) {
      if (!blockIncidences.has(endpoint.key)) blockIncidences.set(endpoint.key, []);
      blockIncidences.get(endpoint.key)?.push({ unit_id: block.unit_id, endpoint });
    }
  }
  const neighborIdsByBlock = new Map(blocks.map((block) => [block.unit_id, new Set<string>()]));
  for (const incidences of blockIncidences.values()) {
    const unitIds = [...new Set(incidences.map((incidence) => incidence.unit_id))];
    for (const unitId of unitIds) for (const neighborId of unitIds) {
      if (neighborId !== unitId) neighborIdsByBlock.get(unitId)?.add(neighborId);
    }
  }

  const protectedOrigins = new Map<string, string>();
  const explicitOriginNodeIds = new Set<number>(blocks.flatMap((block) => [...block.explicit_protected_origin_node_ids]));
  for (const [endpointKey, incidences] of blockIncidences) {
    const endpoint = incidences[0]?.endpoint;
    const terminalInsideBoundary = incidences.length === 1 && endpoint?.point
      && !nearPolygonBoundary(endpoint.point, managerPolygon);
    const explicitOrigin = endpoint?.node_id && explicitOriginNodeIds.has(endpoint.node_id);
    if (!terminalInsideBoundary && !explicitOrigin) continue;
    const suffix = endpoint?.node_id ? String(endpoint.node_id)
      : String(endpointKey).replace(/[^a-zA-Z0-9_-]+/g, '_');
    protectedOrigins.set(endpointKey, `osm_terminal_${suffix}`);
  }
  const protectedGroupsByBlock = new Map(blocks.map((block) => [block.unit_id, new Set<string>()]));
  for (const [originKey, groupId] of [...protectedOrigins.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const originIncidences = blockIncidences.get(originKey) || [];
    for (const originIncidence of originIncidences) {
      let endpointKey = originKey;
      let unitId = originIncidence.unit_id;
      const visited = new Set<string>();
      while (unitId && !visited.has(unitId) && visited.size <= blocks.length) {
        visited.add(unitId);
        protectedGroupsByBlock.get(unitId)?.add(groupId);
        const block = blockById.get(unitId);
        if (!block) break;
        const nextKey = block._start.key === endpointKey ? block._end.key
          : block._end.key === endpointKey ? block._start.key : '';
        if (!nextKey || nextKey === endpointKey || protectedOrigins.has(nextKey)) break;
        const nextIncidences = blockIncidences.get(nextKey) || [];
        if (nextIncidences.length !== 2) break;
        const next = nextIncidences.find((incidence) => incidence.unit_id !== unitId);
        if (!next) break;
        endpointKey = nextKey;
        unitId = next.unit_id;
      }
    }
  }

  const featureOwners = new Map<string, { unit_id: string; distance: number }>();
  for (const block of blocks) {
    for (const feature of block.opportunity_features.values()) {
      const featureId = String(feature?.feature_id || '');
      if (!featureId) continue;
      const distance = Number.isFinite(Number(feature?.association_distance_meters))
        ? Number(feature.association_distance_meters) : Number.POSITIVE_INFINITY;
      const current = featureOwners.get(featureId);
      if (!current || distance < current.distance || distance === current.distance && block.unit_id.localeCompare(current.unit_id) < 0) {
        featureOwners.set(featureId, { unit_id: block.unit_id, distance });
      }
    }
  }
  return blocks.map((block) => {
    const features = [...block.opportunity_features.values()]
      .filter((feature: any) => featureOwners.get(String(feature?.feature_id || ''))?.unit_id === block.unit_id)
      .map((feature: any) => ({ ...feature, associated_unit_id: block.unit_id }))
      .sort((left: any, right: any) => String(left.feature_id).localeCompare(String(right.feature_id)));
    const opportunity = features.length ? 'likely'
      : block.opportunity_states.has('uncertain') ? 'uncertain'
        : block.opportunity_states.has('none') ? 'none' : 'uncertain';
    const access = block.access_states.has('restricted') ? 'restricted'
      : block.access_states.has('uncertain') ? 'uncertain'
        : block.access_states.has('permitted') ? 'permitted' : 'uncertain';
    const kind = [...block.kinds].sort()[0] || 'road';
    const canvasRole = access === 'restricted' ? 'excluded'
      : opportunity === 'likely' && access === 'permitted' ? 'knock'
        : opportunity === 'none' && access === 'permitted' && TRANSIT_HIGHWAYS.has(kind) ? 'transit_only'
          : opportunity === 'none' && access === 'permitted' ? 'excluded' : 'uncertain';
    const sources = [...new Set(features.map((feature: any) => String(feature.source || '')).filter(Boolean))].sort();
    const protectedGroupIds = [...(protectedGroupsByBlock.get(block.unit_id) || [])].sort();
    return {
      id: block.unit_id,
      unit_id: block.unit_id,
      source_way_id: block.source_way_id,
      source_edge_ids: block.source_edge_ids,
      kind,
      canvas_role: canvasRole,
      opportunity_classification: opportunity,
      access_classification: access,
      opportunity_low: features.reduce((sum: number, feature: any) => sum + Number(feature.low || 0), 0),
      opportunity_expected: features.reduce((sum: number, feature: any) => sum + Number(feature.expected || 0), 0),
      opportunity_high: features.reduce((sum: number, feature: any) => sum + Number(feature.high || 0), 0),
      opportunity_source: sources.join('+') || 'none',
      opportunity_features: features,
      confidence: sources.some((source) => ['explicit_residential_units', 'explicit_building_units', 'deduplicated_addresses'].includes(source))
        ? 'high' : features.length ? 'medium' : 'uncertain',
      protected: protectedGroupIds.length > 0,
      ...(protectedGroupIds.length ? { protected_group_id: protectedGroupIds[0], protected_group_ids: protectedGroupIds } : {}),
      street_names: [...block.street_names].sort(),
      neighbor_ids: [...(neighborIdsByBlock.get(block.unit_id) || [])].sort(),
      street_length_meters: Number(block.segments.reduce((sum: number, segment: any) => sum + Number(segment.length_meters || 0), 0).toFixed(2)),
      segments: block.segments
    };
  }).sort((left, right) => left.unit_id.localeCompare(right.unit_id));
}

async function finalizeLargeAnalysis(base44: any, job: any, tiles: any[]) {
  for (const tile of tiles) {
    if (tile.status !== 'complete'
      || !/^[a-f0-9]{64}$/.test(String(tile.raw_evidence_hash || ''))
      || tile.raw_evidence_id !== `canvas_tile_evidence_${tile.raw_evidence_hash}`
      || await sha256(tile.analysis_result || {}) !== tile.analysis_result_hash) {
      throw new HttpError(409, 'canvas_tile_integrity_failed', 'A completed large-area tile failed immutable evidence or analysis-result verification.');
    }
  }
  const streetUnits = mergeStreetUnitResults(tiles, job.polygon);
  const tileManifest = [...tiles].sort((left, right) => Number(left.tile_index) - Number(right.tile_index)).map((tile) => ({
    tile_id: tile.tile_id,
    tile_index: Number(tile.tile_index),
    tile_hash: tile.tile_hash,
    tile_evidence_id: tile.raw_evidence_id,
    tile_evidence_hash: tile.raw_evidence_hash,
    analysis_result_hash: tile.analysis_result_hash,
    analysis_result_bytes: Number(tile.analysis_result_bytes || 0),
    source_version: tile.source_version,
    response_bytes: Number(tile.response_bytes || 0),
    element_count: Number(tile.element_count || 0)
  }));
  const sourceVersion = `osm-tiled-${await sha256(tileManifest.map((tile) => ({ tile_id: tile.tile_id, source_version: tile.source_version, tile_evidence_hash: tile.tile_evidence_hash })))}`;
  const analysisResult = {
    territory_model: 'residential_street_territory_v2',
    street_units: streetUnits,
    unresolved_unit_count: streetUnits.filter((unit: any) => unit.canvas_role === 'uncertain').length,
    opportunity_total_expected: streetUnits.reduce((sum: number, unit: any) => sum + Number(unit.opportunity_expected || 0), 0),
    classifier_version: job.classifier_version
  };
  const content = {
    schema_version: 2,
    manager_id: job.manager_id,
    provider: job.provider,
    source_version: sourceVersion,
    extraction_version: job.extraction_version,
    classifier_version: job.classifier_version,
    polygon: job.polygon,
    raw_evidence: {
      format: 'canvas_immutable_tile_manifest_v1',
      job_id: job.job_id,
      tile_plan_version: job.tile_plan_version,
      tile_count: tileManifest.length,
      tiles: tileManifest
    },
    analysis_result: analysisResult,
    source_attribution: '© OpenStreetMap contributors'
  };
  const snapshotBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
    throw new HttpError(413, 'canvas_composite_snapshot_too_large', 'The merged street evidence exceeds the safe Canvas snapshot limit. Split this unusually dense boundary into separate area plans.');
  }
  const snapshotHash = await sha256(content);
  const evidenceId = `canvas_evidence_${snapshotHash}`;
  const identityLease = await acquireAnalysisIdentityLease(base44, String(job.manager_id));
  try {
    let snapshots = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: job.manager_id }, null, 2, 0));
    if (!snapshots.length) {
      await base44.asServiceRole.entities.CanvasAnalysisSnapshot.create({
        ...content,
        evidence_id: evidenceId,
        snapshot_hash: snapshotHash,
        status: 'complete',
        created_by_user_id: job.created_by_user_id,
        created_at: new Date().toISOString()
      });
      snapshots = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: job.manager_id }, null, 2, 0));
    }
    if (snapshots.length !== 1 || snapshots[0].snapshot_hash !== snapshotHash || snapshots[0].manager_id !== job.manager_id) {
      throw new HttpError(409, 'evidence_identity_collision', 'The composite Canvas evidence identity could not be verified.');
    }
    await ensureRevisionHead(base44, job.manager_id, evidenceId);
  } finally {
    await releaseAnalysisIdentityLease(base44, String(job.manager_id), identityLease);
  }
  return {
    evidence_id: evidenceId,
    snapshot_hash: snapshotHash,
    summary: {
      street_unit_count: streetUnits.length,
      unresolved_unit_count: analysisResult.unresolved_unit_count,
      opportunity_total_expected: analysisResult.opportunity_total_expected,
      area_sq_mi: Number(job.area_sq_mi),
      tile_count: tileManifest.length,
      snapshot_bytes: snapshotBytes,
      development_fallback: false
    }
  };
}

function retryDelayMs(attemptCount: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

function retryableTileError(error: any) {
  return error?.name === 'AbortError' || [429, 500, 502, 503, 504].includes(Number(error?.status));
}

async function ensureDurableTileTasks(base44: any, job: any) {
  const manifest = asArray(job.tile_manifest).sort((left, right) => Number(left.tile_index) - Number(right.tile_index));
  if (!manifest.length || manifest.length !== Number(job.tile_count) || manifest.length > MAX_LARGE_TILE_COUNT) {
    throw new HttpError(409, 'canvas_tile_manifest_invalid', 'The immutable large-area tile manifest is incomplete or invalid.');
  }
  const manifestIds = new Set<string>();
  for (const descriptor of manifest) {
    if (!descriptor?.tile_id || !descriptor?.tile_hash || manifestIds.has(descriptor.tile_id)) throw new HttpError(409, 'canvas_tile_manifest_invalid', 'The immutable large-area tile manifest contains duplicate or invalid tiles.');
    manifestIds.add(descriptor.tile_id);
  }
  let rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: job.job_id, manager_id: job.manager_id }, 'tile_index', MAX_LARGE_TILE_COUNT + 1, 0));
  const byTileId = new Map<string, any[]>();
  for (const row of rows) byTileId.set(row.tile_id, [...(byTileId.get(row.tile_id) || []), row]);
  const now = new Date().toISOString();
  for (const descriptor of manifest) {
    const matches = byTileId.get(descriptor.tile_id) || [];
    if (matches.length > 1) throw new HttpError(409, 'canvas_tile_identity_collision', 'A durable tile task identity is ambiguous.');
    if (matches.length === 1) {
      if (matches[0].tile_hash !== descriptor.tile_hash || Number(matches[0].tile_index) !== Number(descriptor.tile_index)) throw new HttpError(409, 'canvas_tile_identity_collision', 'A durable tile task does not match its immutable manifest.');
      continue;
    }
    await base44.asServiceRole.entities.CanvasAnalysisTile.create({
      job_id: job.job_id,
      manager_id: job.manager_id,
      tile_id: descriptor.tile_id,
      tile_index: descriptor.tile_index,
      tile_hash: descriptor.tile_hash,
      status: 'pending',
      version: 1,
      attempt_count: 0,
      core_polygon: descriptor.core_polygon,
      query_polygon: descriptor.query_polygon,
      query_area_sq_mi: descriptor.query_area_sq_mi,
      updated_at: now
    });
  }
  rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: job.job_id, manager_id: job.manager_id }, 'tile_index', MAX_LARGE_TILE_COUNT + 1, 0));
  if (rows.length !== manifest.length || rows.some((row, index) => row.tile_id !== manifest[index].tile_id || row.tile_hash !== manifest[index].tile_hash)) {
    throw new HttpError(409, 'canvas_tile_manifest_commit_unverified', 'The durable tile tasks do not match their immutable job manifest.');
  }
  return rows;
}

async function processLargeAnalysisJob(base44: any, body: any) {
  const jobId = String(body?.job_id || '').trim();
  const processorToken = String(body?.processor_token || '');
  if (!/^canvas_analysis_job_[a-f0-9]{64}$/.test(jobId)
    || processorToken.length < 64 || processorToken.length > 256
    || !/^canvas_analysis_processor_[A-Za-z0-9_]+$/.test(processorToken)) {
    throw new HttpError(400, 'invalid_canvas_processor_request', 'The large-area processor request is invalid.');
  }
  let job = await loadAnalysisJob(base44, jobId);
  if (job.status === 'complete') {
    job = await compactTerminalAnalysisIntermediates(base44, job);
    return Response.json({ success: true, status: 'complete', job_id: job.job_id, evidence_id: job.evidence_id, snapshot_hash: job.snapshot_hash });
  }
  if (job.status === 'failed') {
    job = await compactTerminalAnalysisIntermediates(base44, job);
    return Response.json({ success: false, status: 'failed', job_id: job.job_id, error: job.error_code, message: job.error_message });
  }
  if (job.status === 'cancelled') {
    job = await compactTerminalAnalysisIntermediates(base44, job);
    return Response.json({ success: true, status: 'cancelled', job_id: job.job_id });
  }
  const locked = await acquireAnalysisLease(base44, job, processorToken);
  if (!locked) {
    const current = await loadAnalysisJob(base44, job.job_id);
    return Response.json({ success: true, status: current.status, job_id: job.job_id, skipped: 'active_processor_lease_or_terminal_state' });
  }
  job = locked;
  try {
    let tiles = await ensureDurableTileTasks(base44, job);
    const staleBefore = Date.now() - ANALYSIS_LEASE_MS;
    const staleProcessingTiles = tiles.filter((tile) => {
      if (tile.status !== 'processing') return false;
      const updatedAt = Date.parse(tile.updated_at || '');
      return !Number.isFinite(updatedAt) || updatedAt <= staleBefore;
    });
    for (const stale of staleProcessingTiles) {
      const expectedVersion = Number(stale.version || 0);
      const exhausted = Number(stale.attempt_count || 0) >= MAX_TILE_ATTEMPTS;
      const mutation = await base44.asServiceRole.entities.CanvasAnalysisTile.updateMany({ id: stale.id, job_id: job.job_id, manager_id: job.manager_id, status: 'processing', version: expectedVersion }, { $set: {
        status: exhausted ? 'failed' : 'pending',
        version: expectedVersion + 1,
        ...(!exhausted ? { next_attempt_at: new Date().toISOString() } : {}),
        error_code: 'canvas_tile_stale_lease',
        error_message: exhausted ? 'This tile exhausted its retry budget after a stale processor lease.' : 'A stale processor lease was recovered and this tile will retry.',
        updated_at: new Date().toISOString()
      }, ...(exhausted ? { $unset: { next_attempt_at: '' } } : {}) });
      if (!mutationCommitted(mutation)) throw new HttpError(409, 'canvas_tile_recovery_conflict', 'A stale tile changed while Canvas was recovering it.');
    }
    if (staleProcessingTiles.length) {
      tiles = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: job.job_id, manager_id: job.manager_id }, 'tile_index', MAX_LARGE_TILE_COUNT + 1, 0));
    }
    const failedTiles = tiles.filter((tile) => tile.status === 'failed');
    if (failedTiles.length) {
      job = await releaseAnalysisLease(base44, job, {
        status: 'failed',
        failed_tile_count: failedTiles.length,
        retryable: true,
        error_code: failedTiles[0].error_code || 'canvas_tile_failed',
        error_message: failedTiles[0].error_message || 'A large-area analysis tile failed.'
      });
      job = await compactTerminalAnalysisIntermediates(base44, job);
      return Response.json({ success: false, status: 'failed', job_id: job.job_id, error: job.error_code, message: job.error_message });
    }
    const completeTiles = tiles.filter((tile) => tile.status === 'complete');
    if (completeTiles.length === tiles.length) {
      const expectedVersion = Number(job.version);
      const finalizingMutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({ id: job.id, job_id: job.job_id, version: expectedVersion, lock_token: job.lock_token }, { $set: { status: 'finalizing', version: expectedVersion + 1, updated_at: new Date().toISOString() } });
      if (!mutationCommitted(finalizingMutation)) throw new HttpError(409, 'canvas_analysis_progress_conflict', 'Canvas could not claim finalization for this analysis.');
      job = await loadAnalysisJob(base44, job.job_id);
      const finalized = await finalizeLargeAnalysis(base44, job, completeTiles);
      job = await releaseAnalysisLease(base44, job, {
        status: 'complete',
        progress_pct: 100,
        completed_tile_count: tiles.length,
        failed_tile_count: 0,
        evidence_id: finalized.evidence_id,
        snapshot_hash: finalized.snapshot_hash,
        summary: finalized.summary,
        retryable: false,
        error_code: '',
        error_message: ''
      });
      job = await compactTerminalAnalysisIntermediates(base44, job);
      return Response.json({ success: true, status: 'complete', job_id: job.job_id, evidence_id: finalized.evidence_id, snapshot_hash: finalized.snapshot_hash, summary: finalized.summary });
    }
    const now = Date.now();
    const candidate = tiles
      .filter((tile) => tile.status === 'pending' && (!tile.next_attempt_at || Date.parse(tile.next_attempt_at) <= now))
      .sort((left, right) => Number(left.tile_index) - Number(right.tile_index))[0];
    if (!candidate) {
      const nextAt = Math.min(...tiles.filter((tile) => tile.status === 'pending' && tile.next_attempt_at).map((tile) => Date.parse(tile.next_attempt_at)).filter(Number.isFinite));
      job = await releaseAnalysisLease(base44, job, {
        status: 'running',
        completed_tile_count: completeTiles.length,
        progress_pct: Number((completeTiles.length / tiles.length * 100).toFixed(2))
      });
      const waitMs = Number.isFinite(nextAt) ? Math.max(0, Math.min(5_000, nextAt - Date.now())) : 2_000;
      await sleep(waitMs);
      await kickLargeAnalysisProcessor(base44, job);
      return Response.json({ success: true, status: 'running', job_id: job.job_id, waiting_for_retry: true });
    }
    const tileExpectedVersion = Number(candidate.version || 0);
    const tileMutation = await base44.asServiceRole.entities.CanvasAnalysisTile.updateMany({ id: candidate.id, job_id: job.job_id, manager_id: job.manager_id, status: 'pending', version: tileExpectedVersion }, { $set: {
      status: 'processing',
      version: tileExpectedVersion + 1,
      attempt_count: Number(candidate.attempt_count || 0) + 1,
      updated_at: new Date().toISOString(),
      error_code: '',
      error_message: ''
    } });
    if (!mutationCommitted(tileMutation)) throw new HttpError(409, 'canvas_tile_claim_conflict', 'Another processor changed the next tile before it was claimed.');
    const processingTile = { ...candidate, status: 'processing', version: tileExpectedVersion + 1, attempt_count: Number(candidate.attempt_count || 0) + 1 };
    try {
      const result = await fetchAndClassifyTile(base44, job, processingTile);
      const completeMutation = await base44.asServiceRole.entities.CanvasAnalysisTile.updateMany({ id: candidate.id, job_id: job.job_id, manager_id: job.manager_id, status: 'processing', version: processingTile.version }, { $set: {
        status: 'complete',
        version: processingTile.version + 1,
        provider: result.endpoint.provider,
        source_version: result.source_version,
        raw_evidence_id: result.tile_evidence_id,
        raw_evidence_hash: result.tile_evidence_hash,
        raw_evidence_bytes: result.raw_evidence_bytes,
        analysis_result: result.analysis_result,
        analysis_result_hash: result.analysis_result_hash,
        analysis_result_bytes: result.analysis_result_bytes,
        response_bytes: result.response_bytes,
        element_count: result.element_count,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, $unset: { next_attempt_at: '' } });
      if (!mutationCommitted(completeMutation)) throw new HttpError(409, 'canvas_tile_commit_conflict', 'The completed tile could not be committed exactly once.');
    } catch (error: any) {
      const mayRetry = retryableTileError(error) && processingTile.attempt_count < MAX_TILE_ATTEMPTS;
      const errorMutation = await base44.asServiceRole.entities.CanvasAnalysisTile.updateMany({ id: candidate.id, job_id: job.job_id, manager_id: job.manager_id, status: 'processing', version: processingTile.version }, { $set: {
        status: mayRetry ? 'pending' : 'failed',
        version: processingTile.version + 1,
        ...(mayRetry ? { next_attempt_at: new Date(Date.now() + retryDelayMs(processingTile.attempt_count)).toISOString() } : {}),
        error_code: String(error?.code || 'canvas_tile_failed'),
        error_message: String(error?.message || 'A large-area analysis tile failed.').slice(0, 1_000),
        updated_at: new Date().toISOString()
      }, ...(mayRetry ? {} : { $unset: { next_attempt_at: '' } }) });
      if (!mutationCommitted(errorMutation)) throw new HttpError(409, 'canvas_tile_failure_commit_conflict', 'The failed tile state could not be recorded exactly once.');
      if (!mayRetry) {
        job = await releaseAnalysisLease(base44, job, {
          status: 'failed',
          failed_tile_count: 1,
          retryable: retryableTileError(error),
          error_code: String(error?.code || 'canvas_tile_failed'),
          error_message: String(error?.message || 'A large-area analysis tile failed.').slice(0, 1_000)
        });
        job = await compactTerminalAnalysisIntermediates(base44, job);
        return Response.json({ success: false, status: 'failed', job_id: job.job_id, error: job.error_code, message: job.error_message });
      }
    }
    const latestTiles = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: job.job_id, manager_id: job.manager_id }, 'tile_index', MAX_LARGE_TILE_COUNT + 1, 0));
    const completedCount = latestTiles.filter((tile) => tile.status === 'complete').length;
    job = await releaseAnalysisLease(base44, job, {
      status: 'running',
      completed_tile_count: completedCount,
      failed_tile_count: latestTiles.filter((tile) => tile.status === 'failed').length,
      progress_pct: Number((completedCount / latestTiles.length * 100).toFixed(2)),
      raw_evidence_bytes: latestTiles.reduce((sum: number, tile: any) => sum + Number(tile.raw_evidence_bytes || 0), 0),
      analysis_result_bytes: latestTiles.reduce((sum: number, tile: any) => sum + Number(tile.analysis_result_bytes || 0), 0)
    });
    await kickLargeAnalysisProcessor(base44, job);
    return Response.json({ success: true, status: 'running', job_id: job.job_id, completed_tile_count: completedCount, tile_count: latestTiles.length, progress_pct: job.progress_pct });
  } catch (error: any) {
    const current = job?.job_id ? await loadAnalysisJob(base44, job.job_id).catch(() => null) : null;
    if (current?.status === 'cancelled') {
      const compacted = await compactTerminalAnalysisIntermediates(base44, current);
      return Response.json({ success: true, status: 'cancelled', job_id: compacted.job_id });
    }
    if (job?.lock_token) {
      const failed = await releaseAnalysisLease(base44, job, {
        status: 'failed',
        retryable: retryableTileError(error),
        error_code: String(error?.code || 'canvas_large_analysis_failed'),
        error_message: String(error?.message || 'Large Canvas analysis failed.').slice(0, 1_000)
      }).catch(() => null);
      if (failed) await compactTerminalAnalysisIntermediates(base44, failed).catch(() => null);
    }
    throw error;
  }
}

async function restartTerminalLargeAnalysis(base44: any, job: any, user: any) {
  if (job.manager_id !== String(user.id) || !['failed', 'cancelled'].includes(job.status) || job.retryable !== true) throw new HttpError(409, 'canvas_analysis_job_not_retryable', 'This Canvas analysis job is not eligible for restart.');
  const priorStatus = job.status;
  const restartTiles = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter({ job_id: job.job_id, manager_id: job.manager_id, status: { $in: ['failed', 'processing'] } }, 'tile_index', MAX_LARGE_TILE_COUNT + 1, 0));
  for (const tile of restartTiles) {
    const expectedVersion = Number(tile.version || 0);
    const mutation = await base44.asServiceRole.entities.CanvasAnalysisTile.updateMany({ id: tile.id, job_id: job.job_id, manager_id: job.manager_id, status: tile.status, version: expectedVersion }, { $set: {
      status: 'pending',
      version: expectedVersion + 1,
      attempt_count: 0,
      error_code: '',
      error_message: '',
      updated_at: new Date().toISOString()
    }, $unset: { next_attempt_at: '' } });
    if (!mutationCommitted(mutation)) throw new HttpError(409, 'canvas_analysis_restart_conflict', 'A terminal analysis tile changed before the analysis could restart.');
  }
  const processorToken = randomToken('canvas_analysis_processor');
  const processorTokenHash = await sha256({ job_id: job.job_id, processor_token: processorToken });
  const expectedVersion = Number(job.version || 0);
  const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({ id: job.id, job_id: job.job_id, manager_id: user.id, status: priorStatus, version: expectedVersion }, { $set: {
    status: 'queued',
    version: expectedVersion + 1,
    failed_tile_count: 0,
    processor_token: processorToken,
    processor_token_hash: processorTokenHash,
    retryable: true,
    error_code: '',
    error_message: '',
    raw_evidence_bytes: 0,
    analysis_result_bytes: 0,
    updated_at: new Date().toISOString()
  }, $unset: { lock_token: '', lock_acquired_at: '', lock_expires_at: '', cancelled_at: '', cancelled_by_user_id: '', intermediate_storage_compacted_at: '', intermediate_storage_policy: '' } });
  if (!mutationCommitted(mutation)) throw new HttpError(409, 'canvas_analysis_restart_conflict', 'The analysis job changed before it could restart.');
  return loadAnalysisJob(base44, job.job_id);
}

async function startLargeAnalysis(base44: any, user: any, polygon: any[], areaSqMi: number, retryFailed: boolean) {
  const endpoint = largeAreaOverpassEndpoint();
  const extractionVersion = String(Deno.env.get('CANVAS_EXTRACTION_VERSION') || 'canvas-overpass-v1');
  const classifierVersion = String(Deno.env.get('CANVAS_CLASSIFIER_VERSION') || 'residential-street-territory-v2.1');
  const cacheEpoch = analysisCacheEpoch();
  const requestHash = await sha256({
    schema_version: 1,
    manager_id: String(user.id),
    polygon,
    tile_plan_version: TILE_PLAN_VERSION,
    provider: endpoint.provider,
    extraction_version: extractionVersion,
    classifier_version: classifierVersion,
    cache_epoch: cacheEpoch
  });
  const jobId = `canvas_analysis_job_${requestHash}`;
  const tiles = await largeTilePlan(polygon);
  const managerId = String(user.id);
  const identityLease = await acquireAnalysisIdentityLease(base44, managerId);
  let job: any = null;
  let response: any = null;
  const staleJobsToCompact: any[] = [];
  try {
    const existing = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: managerId }, null, 2, 0));
    if (existing.length > 1) throw new HttpError(409, 'canvas_analysis_job_identity_collision', 'The large Canvas analysis job identity is ambiguous.');
    job = existing[0] || null;
    if (['failed', 'cancelled'].includes(job?.status) && retryFailed === true) job = await restartTerminalLargeAnalysis(base44, job, user);
    if (job) {
      if (job.status === 'complete') response = { success: true, idempotent: true, status: 'complete', job_id: job.job_id, evidence_id: job.evidence_id, snapshot_hash: job.snapshot_hash, progress_pct: 100, summary: job.summary };
      else if (job.status === 'failed') response = { success: false, status: 'failed', job_id: job.job_id, error: job.error_code, message: job.error_message, retryable: job.retryable === true };
      else if (job.status === 'cancelled') response = { success: true, idempotent: true, status: 'cancelled', job_id: job.job_id, retryable: true };
      else response = { success: true, idempotent: true, status: job.status, job_id: job.job_id, progress_pct: Number(job.progress_pct || 0), completed_tile_count: Number(job.completed_tile_count || 0), tile_count: Number(job.tile_count || 0), poll_after_ms: 1_500 };
    } else {
      let activeJobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ manager_id: managerId, status: { $in: ['queued', 'running', 'finalizing'] } }, '-updated_at', MAX_ACTIVE_ANALYSIS_JOBS_PER_MANAGER + 1, 0));
      const staleBefore = Date.now() - MAX_ANALYSIS_JOB_RUNTIME_MS;
      for (const activeJob of activeJobs) {
        const updatedAt = Date.parse(activeJob.updated_at || activeJob.created_at || '');
        if (Number.isFinite(updatedAt) && updatedAt > staleBefore) continue;
        const expectedVersion = Number(activeJob.version || 0);
        const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({ id: activeJob.id, manager_id: managerId, job_id: activeJob.job_id, version: expectedVersion, status: { $in: ['queued', 'running', 'finalizing'] } }, { $set: {
          status: 'failed',
          version: expectedVersion + 1,
          retryable: true,
          error_code: 'canvas_analysis_job_expired',
          error_message: 'This analysis exceeded the two-hour safety window and can be restarted.',
          updated_at: new Date().toISOString()
        }, $unset: { lock_token: '', lock_acquired_at: '', lock_expires_at: '' } }).catch(() => null);
        if (mutationCommitted(mutation)) staleJobsToCompact.push({ ...activeJob, status: 'failed', version: expectedVersion + 1 });
      }
      activeJobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ manager_id: managerId, status: { $in: ['queued', 'running', 'finalizing'] } }, '-updated_at', MAX_ACTIVE_ANALYSIS_JOBS_PER_MANAGER + 1, 0));
      if (activeJobs.length >= MAX_ACTIVE_ANALYSIS_JOBS_PER_MANAGER) {
        throw new HttpError(429, 'canvas_analysis_concurrency_limit', `Finish one of the ${MAX_ACTIVE_ANALYSIS_JOBS_PER_MANAGER} active large Canvas analyses before starting another.`);
      }
      const processorToken = randomToken('canvas_analysis_processor');
      const processorTokenHash = await sha256({ job_id: jobId, processor_token: processorToken });
      const now = new Date().toISOString();
      const created = await base44.asServiceRole.entities.CanvasAnalysisJob.create({
        job_id: jobId, request_hash: requestHash, cache_epoch: cacheEpoch, manager_id: managerId,
        created_by_user_id: managerId, created_at: now, updated_at: now, status: 'queued', version: 1,
        polygon, area_sq_mi: Number(areaSqMi.toFixed(3)), tile_plan_version: TILE_PLAN_VERSION,
        tile_manifest: tiles, tile_count: tiles.length, completed_tile_count: 0, failed_tile_count: 0,
        progress_pct: 0, raw_evidence_bytes: 0, analysis_result_bytes: 0, provider: endpoint.provider,
        extraction_version: extractionVersion, classifier_version: classifierVersion,
        processor_token: processorToken, processor_token_hash: processorTokenHash, retryable: true
      });
      if (!created || created.job_id !== jobId || created.manager_id !== managerId) throw new HttpError(503, 'canvas_analysis_job_commit_unverified', 'The large Canvas analysis job could not be verified after creation.');
      const committedJobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: managerId }, null, 2, 0));
      if (committedJobs.length !== 1 || asArray(committedJobs[0].tile_manifest).length !== tiles.length) throw new HttpError(503, 'canvas_tile_manifest_commit_unverified', 'The large Canvas tile manifest could not be verified after creation.');
      job = committedJobs[0];
      response = { success: true, idempotent: false, status: 'queued', job_id: jobId, progress_pct: 0, completed_tile_count: 0, tile_count: tiles.length, area_sq_mi: Number(areaSqMi.toFixed(3)), poll_after_ms: 1_500 };
    }
  } finally {
    await releaseAnalysisIdentityLease(base44, managerId, identityLease);
  }
  for (const staleJob of staleJobsToCompact) await compactTerminalAnalysisIntermediates(base44, staleJob).catch(() => null);
  if (job && ['queued', 'running', 'finalizing'].includes(job.status)) await kickLargeAnalysisProcessor(base44, job);
  else if (job && ['complete', 'failed', 'cancelled'].includes(job.status)) await compactTerminalAnalysisIntermediates(base44, job).catch(() => null);
  return response;
}

async function ensureRevisionHead(base44: any, managerId: string, evidenceId: string) {
  const headKey = `${managerId}:${evidenceId}`;
  let rows = await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({ head_key: headKey, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0).catch(() => []);
  rows = Array.isArray(rows) ? rows : rows?.items || [];
  if (!rows.length) {
    await base44.asServiceRole.entities.CanvasClassificationRevisionHead.create({ head_key: headKey, manager_id: managerId, evidence_id: evidenceId, head_revision_id: null, version: 0, updated_at: new Date().toISOString(), updated_by_user_id: managerId });
    rows = await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({ head_key: headKey, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0);
    rows = Array.isArray(rows) ? rows : rows?.items || [];
  }
  if (rows.length !== 1 || rows[0].manager_id !== managerId || rows[0].evidence_id !== evidenceId) throw new HttpError(409, 'revision_head_ambiguous', 'The classification revision head could not be initialized safely.');
}

Deno.serve(async (req: Request) => {
  let controller: AbortController | null = null;
  let timeout: number | null = null;
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body?.internal_action === 'process_large_analysis_job') return processLargeAnalysisJob(base44, body);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'manager_access_required' }, { status: 403 });
    if (!hasCanvasDraftAccess(user)) return Response.json({ error: 'canvas_entitlement_required' }, { status: 403 });
    const polygon = normalizePolygon(body?.polygon);
    const areaSqMi = polygonAreaSqMi(polygon);
    if (!(areaSqMi > 0) || areaSqMi > MAX_LARGE_AREA_SQ_MI) throw new HttpError(422, 'canvas_analysis_area_limit', `Server analysis supports boundaries up to ${MAX_LARGE_AREA_SQ_MI} square miles.`);
    if (areaSqMi > MAX_AREA_SQ_MI) return Response.json(await startLargeAnalysis(base44, user, polygon, areaSqMi, body?.retry_failed_job === true));
    const endpoint = overpassEndpoint();
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), OVERPASS_TIMEOUT_MS);
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: providerHeaders(),
      body: new URLSearchParams({ data: overpassQuery(polygon) }),
      signal: controller.signal
    });
    const providerPayload = await readBoundedJson(response);
    const rawEvidence = normalizedRawEvidence(providerPayload);
    const streetUnits = classifyStreetEvidence(rawEvidence, polygon);
    const sourceVersion = rawEvidence.osm_base;
    const extractionVersion = String(Deno.env.get('CANVAS_EXTRACTION_VERSION') || 'canvas-overpass-v1');
    const classifierVersion = String(Deno.env.get('CANVAS_CLASSIFIER_VERSION') || 'residential-street-territory-v2.1');
    const analysisResult = {
      territory_model: 'residential_street_territory_v2',
      street_units: streetUnits,
      unresolved_unit_count: streetUnits.filter((unit: any) => unit.canvas_role === 'uncertain').length,
      opportunity_total_expected: streetUnits.reduce((sum: number, unit: any) => sum + Number(unit.opportunity_expected || 0), 0),
      classifier_version: classifierVersion
    };
    const content = {
      schema_version: 1,
      manager_id: String(user.id),
      provider: endpoint.provider,
      source_version: sourceVersion,
      extraction_version: extractionVersion,
      classifier_version: classifierVersion,
      polygon,
      raw_evidence: rawEvidence,
      analysis_result: analysisResult,
      source_attribution: '© OpenStreetMap contributors'
    };
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) throw new HttpError(413, 'canvas_analysis_snapshot_too_large', 'The canonical evidence snapshot exceeds the Phase 1 entity payload limit. Reduce the boundary or feature density.');
    const snapshotHash = await sha256(content);
    const evidenceId = `canvas_evidence_${snapshotHash}`;
    const managerId = String(user.id);
    const identityLease = await acquireAnalysisIdentityLease(base44, managerId);
    let idempotent = false;
    try {
      const existingRows = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: managerId }, null, 2, 0).catch(() => []));
      if (existingRows.length > 1) throw new HttpError(409, 'evidence_identity_collision', 'The evidence identity is not unique in this manager tenant.');
      const existing = existingRows[0];
      if (existing) {
        if (existing.snapshot_hash !== snapshotHash || existing.manager_id !== managerId) throw new HttpError(409, 'evidence_identity_collision', 'An evidence identifier collision was detected.');
        idempotent = true;
      } else {
        const createdAt = new Date().toISOString();
        const created = await base44.asServiceRole.entities.CanvasAnalysisSnapshot.create({ ...content, evidence_id: evidenceId, snapshot_hash: snapshotHash, status: 'complete', created_by_user_id: managerId, created_at: createdAt });
        if (!created || created.evidence_id !== evidenceId || created.snapshot_hash !== snapshotHash || created.manager_id !== managerId) {
          throw new HttpError(503, 'evidence_commit_unverified', 'The immutable evidence snapshot could not be verified after creation.');
        }
      }
      const committedRows = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: managerId }, null, 2, 0));
      if (committedRows.length !== 1 || committedRows[0].snapshot_hash !== snapshotHash) throw new HttpError(409, 'evidence_identity_collision', 'The evidence identity is not unique in this manager tenant.');
      await ensureRevisionHead(base44, managerId, evidenceId);
    } finally {
      await releaseAnalysisIdentityLease(base44, managerId, identityLease);
    }
    return Response.json({ success: true, idempotent, evidence_id: evidenceId, snapshot_hash: snapshotHash, status: 'complete', provider: endpoint.provider, source_version: sourceVersion, extraction_version: extractionVersion, classifier_version: classifierVersion, summary: { street_unit_count: streetUnits.length, unresolved_unit_count: analysisResult.unresolved_unit_count, area_sq_mi: Number(areaSqMi.toFixed(3)), snapshot_bytes: snapshotBytes, development_fallback: endpoint.development_fallback } });
  } catch (error: any) {
    if (error?.name === 'AbortError') return Response.json({ error: 'canvas_analysis_timeout', message: 'The server-side OSM analysis timed out.' }, { status: 504 });
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    console.error('[canvasStartAnalysis]', error?.message || error);
    return Response.json({ error: 'canvas_analysis_failed', message: 'Server-side Canvas analysis failed.' }, { status: 503 });
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
});
