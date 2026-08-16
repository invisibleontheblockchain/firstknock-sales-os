#!/usr/bin/env node
// OpenStreetMap source adapter: pinned bulk extract -> Canvas source-evidence v1.
//
// This is the front of the evidence pipeline. It reads a pinned OSM extract
// offline and emits strict source-evidence v1 tiles, which
// `normalize-source.mjs` turns into release-builder input.
//
//   pinned .osm.pbf -> [this] -> source-evidence v1 -> normalize-source -> build-release
//
// It never calls a live map API. It never invents evidence: where OSM does not
// say whether something is residential, the adapter emits what it saw and lets
// the normalizer's decision table return `uncertain`, which carries zero
// workload downstream. Guessing here would produce a confident wrong territory.
//
// ODbL: every emitted record carries the provider, dataset version and license
// supplied on the command line, so a release can always be traced to its input.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import parseOSM from 'osm-pbf-parser';
import through from 'through2';

const USAGE = `Compile a pinned OSM extract into Canvas source-evidence v1 tiles.

Usage:
  node scripts/canvas-evidence/osm-source-adapter.mjs \\
    --pbf <extract.osm.pbf> \\
    --bbox <minLng,minLat,maxLng,maxLat> \\
    --tile-key <tile-key> \\
    --source-id <provider-source-id> \\
    --dataset-version <pinned-version> \\
    --license <license-string> \\
    --observed-at <iso-8601> \\
    --output <source-tile.json>

Every provenance field is required. There is no default license or version:
an untraceable release must not be possible to produce by accident.
`;

const MAX_ASSOCIATION_METERS = 60;
const EARTH_RADIUS_METERS = 6371008.8;

// OSM highway values the source-evidence contract accepts verbatim.
const ROAD_CLASSES = new Set([
  'residential', 'living_street', 'service', 'unclassified', 'tertiary',
  'secondary', 'primary', 'tertiary_link', 'secondary_link', 'primary_link',
  'trunk', 'trunk_link', 'motorway', 'motorway_link', 'pedestrian', 'path',
  'footway', 'cycleway', 'track',
]);

const BUILDING_USES = new Set([
  'yes', 'house', 'detached', 'semidetached_house', 'terrace', 'residential',
  'apartments', 'dormitory', 'mixed_use', 'commercial', 'retail', 'office',
  'warehouse', 'industrial', 'hotel', 'school', 'hospital', 'civic', 'public',
  'religious', 'garage', 'garages', 'nonresidential',
]);

/* ────────────────────────────── geometry ────────────────────────────── */

const toRadians = (degrees) => (degrees * Math.PI) / 180;

function haversineMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Distance from a point to a segment, in meters, using a local planar
// approximation. Accurate enough at blockface scale and far cheaper than a
// spherical solution for the association sweep.
function pointToSegmentMeters(point, start, end) {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos(toRadians(point.lat));
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const insideBounds = (lat, lng, b) => lat >= b.min_lat && lat <= b.max_lat && lng >= b.min_lng && lng <= b.max_lng;

// Cell ownership is half-open — [min, max) on both axes — so a segment whose
// midpoint lands exactly on a shared edge belongs to exactly one cell. With
// inclusive bounds, adjacent compiles both claimed it and the release refused
// the whole thing with duplicate_release_work_unit. Rare per pair, certain
// across thousands of cells.
const ownsMidpoint = (lat, lng, b) => lat >= b.min_lat && lat < b.max_lat && lng >= b.min_lng && lng < b.max_lng;

/* ────────────────────────────── tag reading ────────────────────────────── */

export function roadClassOf(tags) {
  const highway = String(tags.highway || '');
  return ROAD_CLASSES.has(highway) ? highway : 'unknown';
}

// Legal access is classified separately from residential opportunity, and an
// unsigned barrier is `unknown` rather than denied. Access that OSM does not
// state is `public` only for ordinary public road classes.
export function legalAccessOf(tags) {
  const access = String(tags.access || '').toLowerCase();
  const foot = String(tags.foot || '').toLowerCase();
  if (foot === 'no' || access === 'no') return 'denied';
  if (foot === 'yes' || foot === 'designated' || foot === 'permissive') return 'permitted';
  if (access === 'private') return 'denied';
  if (access === 'permissive' || access === 'destination') return 'permitted';
  if (access === 'customers' || access === 'delivery') return 'unknown';
  return 'public';
}

export function buildingUseOf(tags) {
  const building = String(tags.building || '').toLowerCase();
  if (BUILDING_USES.has(building)) return building;
  if (building) return 'yes';
  return null;
}

// Occupancy is only claimed where OSM supports it. Everything else is
// `unknown`, which is an honest answer the decision table knows how to use.
export function occupancyOf(tags) {
  const building = String(tags.building || '').toLowerCase();
  const use = String(tags['building:use'] || '').toLowerCase();
  const residential = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'apartments', 'dormitory']);
  const commercial = new Set(['commercial', 'retail', 'office', 'warehouse', 'industrial', 'hotel', 'school', 'hospital', 'civic', 'public', 'religious']);
  if (residential.has(building) || residential.has(use)) return 'residential';
  if (commercial.has(building) || commercial.has(use)) return 'commercial';
  if (building === 'mixed_use' || use === 'mixed_use') return 'mixed';
  if (tags.shop || tags.office) return 'commercial';
  return 'unknown';
}

// The contract enumerates place and land use separately from OSM's tag space,
// so anything unrecognised is dropped rather than coerced. A wrong exclusion is
// as damaging as a wrong inclusion.
const PLACE_USES = new Set([
  'residential', 'mixed_use', 'shop', 'commercial', 'retail', 'office', 'warehouse',
  'industrial', 'school', 'university', 'hospital', 'institutional', 'government',
  'religious', 'hotel', 'parking', 'sports', 'nonresidential',
]);

const LAND_USES = new Set([
  'residential', 'mixed_use', 'commercial', 'retail', 'office', 'industrial',
  'farmland', 'farmyard', 'meadow', 'orchard', 'forest', 'quarry', 'construction',
  'institutional', 'education', 'healthcare', 'military', 'cemetery', 'recreation', 'parking',
]);

const AMENITY_PLACE_USE = new Map([
  ['school', 'school'], ['university', 'university'], ['college', 'university'],
  ['hospital', 'hospital'], ['clinic', 'hospital'], ['doctors', 'hospital'],
  ['place_of_worship', 'religious'], ['townhall', 'government'], ['courthouse', 'government'],
  ['police', 'government'], ['fire_station', 'government'], ['post_office', 'government'],
  ['library', 'institutional'], ['parking', 'parking'], ['restaurant', 'commercial'],
  ['cafe', 'commercial'], ['bar', 'commercial'], ['pub', 'commercial'], ['fast_food', 'commercial'],
  ['bank', 'office'], ['pharmacy', 'retail'], ['fuel', 'commercial'], ['kindergarten', 'school'],
]);

export function placeUseOf(tags) {
  if (tags.shop) return 'shop';
  if (tags.office) return 'office';
  const amenity = String(tags.amenity || '').toLowerCase();
  return AMENITY_PLACE_USE.get(amenity) || null;
}

export function landUseOf(tags) {
  const value = String(tags.landuse || '').toLowerCase();
  if (LAND_USES.has(value)) return value;
  if (value === 'retail') return 'retail';
  if (value === 'grass' || value === 'village_green') return 'recreation';
  if (value === 'allotments') return 'recreation';
  return null;
}

export function pedestrianAccessOf(tags) {
  const foot = String(tags.foot || '').toLowerCase();
  if (foot === 'yes' || foot === 'designated' || foot === 'permissive') return 'allowed';
  if (foot === 'no' || foot === 'private') return 'denied';
  return 'unknown';
}

function normalizeStreetName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|lane|ln|terrace|ter|boulevard|blvd)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/* ────────────────────────────── extract read ────────────────────────────── */

// V8 caps a single Map at ~16.7M entries, and a state-sized extract holds more
// nodes than that — the compile died with "Map maximum size exceeded". Sharding
// the node store across several Maps raises the ceiling proportionally without
// changing the lookup cost, and whole-extract compiles are mandatory: segment
// identities are only stable when one run sees the entire way.
const NODE_SHARD_COUNT = 32;

// Fallback store, used only when an extract's node ids are not ascending.
// A Map entry plus a {lat,lng} object costs roughly 100 bytes per node, which
// is what put California past this machine's memory: correctness never depends
// on the extract's ordering, but the cheap path below does.
function createMapNodeStore() {
  const shards = Array.from({ length: NODE_SHARD_COUNT }, () => new Map());
  const shardFor = (id) => shards[Number(BigInt(id) % BigInt(NODE_SHARD_COUNT))];
  return {
    set(id, lat, lng) { shardFor(id).set(id, { lat, lng }); },
    get(id) { return shardFor(id).get(id); },
    has(id) { return shardFor(id).has(id); },
    get size() { return shards.reduce((total, shard) => total + shard.size, 0); },
  };
}

// Chunked parallel typed arrays: 24 bytes per node against ~100 for a Map of
// objects. That ratio is the difference between a state that compiles and one
// that swaps — norcal died at a 12 GB heap, and whole California wanted ~21 GB.
//
// Chunks rather than one growable array because doubling a 2.4 GB buffer needs
// the old and new copies live at once, and that transient spike is exactly the
// headroom we are short of. Ids are exact in Float64 (the largest OSM node id
// is ~1.2e10, far below 2^53).
//
// PBF emits nodes in ascending id order, so each chunk is sorted and chunk
// ranges are disjoint — a lookup binary-searches the chunk list, then the
// chunk. If an extract ever violates that, the store converts itself to the
// map form above rather than returning a wrong coordinate.
const NODE_CHUNK_ENTRIES = 1 << 22;

function createNodeStore() {
  const chunks = [];
  let count = 0;
  let lastId = -Infinity;
  let fallback = null;

  const locate = (id) => {
    let low = 0;
    let high = chunks.length - 1;
    let target = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (chunks[mid].ids[chunks[mid].length - 1] >= id) { target = mid; high = mid - 1; } else low = mid + 1;
    }
    if (target < 0) return null;
    const chunk = chunks[target];
    let a = 0;
    let b = chunk.length - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      const value = chunk.ids[mid];
      if (value === id) return { chunk, offset: mid };
      if (value < id) a = mid + 1; else b = mid - 1;
    }
    return null;
  };

  const convertToFallback = () => {
    fallback = createMapNodeStore();
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += 1) {
        fallback.set(chunk.ids[offset], chunk.lats[offset], chunk.lngs[offset]);
      }
    }
    chunks.length = 0;
  };

  return {
    set(id, lat, lng) {
      if (fallback) { fallback.set(id, lat, lng); return; }
      if (id <= lastId) { convertToFallback(); fallback.set(id, lat, lng); return; }
      lastId = id;
      let chunk = chunks[chunks.length - 1];
      if (!chunk || chunk.length === NODE_CHUNK_ENTRIES) {
        chunk = {
          ids: new Float64Array(NODE_CHUNK_ENTRIES),
          lats: new Float64Array(NODE_CHUNK_ENTRIES),
          lngs: new Float64Array(NODE_CHUNK_ENTRIES),
          length: 0,
        };
        chunks.push(chunk);
      }
      chunk.ids[chunk.length] = id;
      chunk.lats[chunk.length] = lat;
      chunk.lngs[chunk.length] = lng;
      chunk.length += 1;
      count += 1;
    },
    get(id) {
      if (fallback) return fallback.get(id);
      const found = locate(id);
      return found ? { lat: found.chunk.lats[found.offset], lng: found.chunk.lngs[found.offset] } : undefined;
    },
    has(id) {
      if (fallback) return fallback.has(id);
      return locate(id) !== null;
    },
    get size() { return fallback ? fallback.size : count; },
  };
}

async function readExtract(pbfPath, bounds) {
  // Nodes stream before ways, so one pass suffices: hold coordinates, then use
  // them to place ways. A margin keeps ways that cross the tile edge intact.
  const margin = 0.01;
  const wide = {
    min_lat: bounds.min_lat - margin,
    max_lat: bounds.max_lat + margin,
    min_lng: bounds.min_lng - margin,
    max_lng: bounds.max_lng + margin,
  };
  const nodeCoords = createNodeStore();
  const taggedNodes = [];
  const ways = [];

  await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(pbfPath)
      .pipe(parseOSM())
      .pipe(through.obj((items, _enc, next) => {
        for (const item of items) {
          if (item.type === 'node') {
            if (!insideBounds(item.lat, item.lon, wide)) continue;
            nodeCoords.set(item.id, item.lat, item.lon);
            const tags = item.tags || {};
            if (tags['addr:housenumber'] || tags.barrier || tags.shop || tags.amenity || tags.office || tags.entrance) {
              taggedNodes.push({ id: item.id, lat: item.lat, lng: item.lon, tags });
            }
          } else if (item.type === 'way') {
            const tags = item.tags || {};
            if (!tags.highway && !tags.building && !tags.landuse && !tags.barrier && !tags.shop && !tags.amenity) continue;
            // Only the centroid is ever read from a way's coordinates, so it is
            // accumulated here instead of keeping a resolved point per node —
            // that array was the second largest allocation in the compile.
            // The arithmetic mirrors the previous reduce exactly (each term
            // divided before summing, in ref order) so results stay identical.
            const refs = item.refs || [];
            let resolved = 0;
            for (const ref of refs) if (nodeCoords.has(ref)) resolved += 1;
            if (!resolved) continue;
            const centroid = { lat: 0, lng: 0 };
            for (const ref of refs) {
              const point = nodeCoords.get(ref);
              if (!point) continue;
              centroid.lat += point.lat / resolved;
              centroid.lng += point.lng / resolved;
            }
            ways.push({ id: item.id, refs, tags, centroid });
          }
        }
        next();
      }))
      .on('finish', resolvePromise)
      .on('error', rejectPromise);
  });

  return { nodeCoords, taggedNodes, ways };
}

/* ────────────────────────── blockface segmentation ────────────────────────── */

// The atomic unit of ownership is a street-side segment between intersections,
// so highway ways are split wherever another highway way touches them.
function buildRoadSegments(ways, nodeCoords, bounds, provenanceOf) {
  const highways = ways.filter((way) => way.tags.highway && ROAD_CLASSES.has(String(way.tags.highway)));
  const nodeDegree = new Map();
  for (const way of highways) {
    for (const ref of way.refs) nodeDegree.set(ref, (nodeDegree.get(ref) || 0) + 1);
  }

  const segments = [];
  for (const way of highways) {
    const refs = way.refs.filter((ref) => nodeCoords.has(ref));
    if (refs.length < 2) continue;

    // Cumulative length lets a segment record where it sits along its parent.
    const cumulative = [0];
    for (let index = 1; index < refs.length; index += 1) {
      cumulative.push(cumulative[index - 1] + haversineMeters(nodeCoords.get(refs[index - 1]), nodeCoords.get(refs[index])));
    }
    const total = cumulative[cumulative.length - 1];
    if (total <= 0) continue;

    let startIndex = 0;
    let segmentIndex = 0;
    for (let index = 1; index < refs.length; index += 1) {
      const isSplit = index === refs.length - 1 || (nodeDegree.get(refs[index]) || 0) > 1;
      if (!isSplit) continue;
      const sliceRefs = refs.slice(startIndex, index + 1);
      const coordinates = sliceRefs.map((ref) => {
        const point = nodeCoords.get(ref);
        return [Number(point.lng.toFixed(7)), Number(point.lat.toFixed(7))];
      });
      const midpoint = nodeCoords.get(sliceRefs[Math.floor(sliceRefs.length / 2)]);
      if (ownsMidpoint(midpoint.lat, midpoint.lng, bounds) && coordinates.length >= 2) {
        segments.push({
          identity: {
            source_namespace: 'osm-way',
            source_feature_id: `way/${way.id}`,
            segment_index: segmentIndex,
            from_millionths: Math.round((cumulative[startIndex] / total) * 1_000_000),
            to_millionths: Math.round((cumulative[index] / total) * 1_000_000),
          },
          geometry: { type: 'LineString', coordinates },
          road_class: roadClassOf(way.tags),
          legal_access: legalAccessOf(way.tags),
          provenance: provenanceOf(`way/${way.id}#${segmentIndex}`),
          neighbors: [],
          _startRef: sliceRefs[0],
          _endRef: sliceRefs[sliceRefs.length - 1],
          _refs: sliceRefs,
          _streetName: normalizeStreetName(way.tags.name),
          _coordPoints: sliceRefs.map((ref) => nodeCoords.get(ref)),
        });
      }
      segmentIndex += 1;
      startIndex = index;
    }
  }

  // Neighbours are segments sharing an endpoint. Connectivity is what lets the
  // partitioner guarantee a walkable territory, so it is derived, never assumed.
  const byEndpoint = new Map();
  for (const segment of segments) {
    for (const ref of [segment._startRef, segment._endRef]) {
      if (!byEndpoint.has(ref)) byEndpoint.set(ref, []);
      byEndpoint.get(ref).push(segment);
    }
  }
  // A segment selected for this tile can touch one that was not. The contract
  // models that as `outside_release` rather than a dangling reference, which is
  // what keeps topology honest at a tile seam instead of severing it.
  const emitted = new Set(segments.map((segment) => `${segment.identity.source_feature_id}#${segment.identity.segment_index}`));
  for (const segment of segments) {
    const seen = new Set();
    for (const ref of [segment._startRef, segment._endRef]) {
      for (const other of byEndpoint.get(ref) || []) {
        if (other === segment) continue;
        const key = `${other.identity.source_feature_id}#${other.identity.segment_index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        segment.neighbors.push({
          identity: { ...other.identity },
          scope: emitted.has(key) ? 'release' : 'outside_release',
        });
      }
    }
  }
  return { segments, byEndpoint };
}

// A cul-de-sac is a dead end: a segment whose far endpoint carries no other
// segment. These groups must stay whole through partitioning.
function buildProtectedGroups(segments, byEndpoint) {
  const groups = [];
  for (const segment of segments) {
    const startCount = (byEndpoint.get(segment._startRef) || []).length;
    const endCount = (byEndpoint.get(segment._endRef) || []).length;
    const deadEnd = startCount === 1 || endCount === 1;
    if (!deadEnd) continue;
    if (segment.neighbors.length === 0) continue; // isolated, not a pocket
    groups.push({
      kind: 'cul_de_sac',
      members: [{ ...segment.identity }],
      entries: [{ ...segment.identity }],
    });
  }
  return groups;
}

/* ────────────────────────────── evidence ────────────────────────────── */

// A sidewalk is not an address. OSM maps footways as separate ways running
// closer to the front door than the street centreline, so a naive nearest-road
// sweep attaches most houses to the pavement outside them.
//
// Measured on Capitol Hill before this filter: 528 of 733 knockable units (72%)
// were footways, carrying 3,945 of 5,048 doors. The door TOTAL was right — the
// classifier promotes any unit holding residential evidence, so nothing was
// lost — but the ownership geometry was wrong. A rep would have been handed
// pavement segments rather than blockfaces, and adjacency, cul-de-sac grouping
// and exclusive ownership all key off these units. Doors may only be owned by a
// way that can itself hold an address.
const ADDRESSABLE_ROAD_CLASSES = new Set([
  'residential', 'living_street', 'service', 'unclassified', 'tertiary',
  'secondary', 'primary', 'tertiary_link', 'secondary_link', 'primary_link',
  'trunk', 'trunk_link', 'track', 'unknown',
]);

// Association is the adapter's hot path: every address, building, barrier and
// land-use polygon has to find its nearest road. Scanning all segments per
// feature is O(features x segments) — tolerable over one square mile, hopeless
// over a metro. Segments are bucketed into a coarse lat/lng grid once, and each
// lookup then visits only the buckets within the association radius.
const INDEX_CELL_DEGREES = 0.002; // ~200m; comfortably wider than MAX_ASSOCIATION_METERS

function buildSegmentIndex(segments) {
  const cells = new Map();
  const key = (row, col) => `${row}:${col}`;
  for (const segment of segments) {
    const seen = new Set();
    for (const point of segment._coordPoints) {
      const row = Math.floor(point.lat / INDEX_CELL_DEGREES);
      const col = Math.floor(point.lng / INDEX_CELL_DEGREES);
      const cellKey = key(row, col);
      if (seen.has(cellKey)) continue;
      seen.add(cellKey);
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push(segment);
    }
  }
  return {
    // Every segment whose geometry touches a cell within one ring of the point.
    near(point) {
      const row = Math.floor(point.lat / INDEX_CELL_DEGREES);
      const col = Math.floor(point.lng / INDEX_CELL_DEGREES);
      const found = new Set();
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        for (let dCol = -1; dCol <= 1; dCol += 1) {
          for (const segment of cells.get(key(row + dRow, col + dCol)) || []) found.add(segment);
        }
      }
      return found;
    },
  };
}

function associateToSegment(point, index, streetName, contextualMethod = null, addressable = false) {
  let best = null;
  let bestNamed = null;
  for (const segment of index.near(point)) {
    if (addressable && !ADDRESSABLE_ROAD_CLASSES.has(segment.road_class)) continue;
    const points = segment._coordPoints;
    for (let index = 1; index < points.length; index += 1) {
      const distance = pointToSegmentMeters(point, points[index - 1], points[index]);
      if (distance > MAX_ASSOCIATION_METERS) continue;
      if (!best || distance < best.distance) best = { segment, distance };
      // A matching street name beats proximity outright, so the nearest
      // *named* match is tracked separately from the nearest anything.
      if (streetName && segment._streetName === streetName
        && (!bestNamed || distance < bestNamed.distance)) {
        bestNamed = { segment, distance };
      }
    }
  }
  if (bestNamed) best = bestNamed;
  if (!best) return null;
  // A matching street name is far stronger than proximity, and the contract
  // ranks it first. Without one this stays `nearest_road`, the weakest method.
  if (contextualMethod) {
    // land_use and place associate by area overlap; access and barrier by
    // network link. The contract rejects a distance on either.
    return { method: contextualMethod, road_identity: { ...best.segment.identity } };
  }
  const named = streetName && best.segment._streetName && streetName === best.segment._streetName;
  if (named) return { method: 'address_street', road_identity: { ...best.segment.identity } };
  return {
    method: 'nearest_road',
    road_identity: { ...best.segment.identity },
    distance_m: Number(best.distance.toFixed(2)),
  };
}

function buildEvidence(ways, taggedNodes, segments, nodeCoords, provenanceOf) {
  const index = buildSegmentIndex(segments);
  const evidence = [];
  const push = (id, kind, attributes, association) => {
    if (!association) return;
    evidence.push({
      evidence_id: id,
      kind,
      attributes,
      associations: [association],
      provenance: provenanceOf(id),
    });
  };

  for (const node of taggedNodes) {
    const point = { lat: node.lat, lng: node.lng };
    const tags = node.tags;
    if (tags['addr:housenumber']) {
      const street = normalizeStreetName(tags['addr:street']);
      push(`node/${node.id}`, 'address', {
        address_key: `${tags['addr:housenumber']}-${normalizeStreetName(tags['addr:street']) || 'unknown'}`,
        unit_keys: tags['addr:unit'] ? [String(tags['addr:unit'])] : [],
        occupancy: occupancyOf(tags),
      }, associateToSegment(point, index, street, null, true));
    } else if (tags.barrier) {
      push(`node/${node.id}`, 'barrier', {
        barrier_type: String(tags.barrier).slice(0, 80),
        pedestrian_access: pedestrianAccessOf(tags),
      }, associateToSegment(point, index, null, 'network_link'));
    } else if (tags.shop || tags.amenity || tags.office) {
      const placeUse = placeUseOf(tags);
      if (placeUse) {
        push(`node/${node.id}`, 'place', { place_use: placeUse },
          associateToSegment(point, index, null, 'area_overlap'));
      }
    }
  }

  for (const way of ways) {
    const tags = way.tags;
    const { centroid } = way;

    if (tags.building) {
      const use = buildingUseOf(tags);
      if (!use) continue;
      const street = normalizeStreetName(tags['addr:street']);
      const association = associateToSegment(centroid, index, street, null, true);
      push(`way/${way.id}`, 'building', {
        building_use: use,
        ...(Number.parseInt(tags['building:units'], 10) > 0 ? { unit_count: Number.parseInt(tags['building:units'], 10) } : {}),
      }, association);
      if (tags['addr:housenumber']) {
        push(`way/${way.id}/addr`, 'address', {
          address_key: `${tags['addr:housenumber']}-${street || 'unknown'}`,
          unit_keys: tags['addr:unit'] ? [String(tags['addr:unit'])] : [],
          occupancy: occupancyOf(tags),
        }, association);
      }
    } else if (tags.landuse) {
      const landUse = landUseOf(tags);
      if (landUse) {
        push(`way/${way.id}`, 'land_use', { land_use: landUse },
          associateToSegment(centroid, index, null, 'area_overlap'));
      }
    } else if (tags.shop || tags.amenity) {
      const placeUse = placeUseOf(tags);
      if (placeUse) {
        push(`way/${way.id}`, 'place', { place_use: placeUse },
          associateToSegment(centroid, index, null, 'area_overlap'));
      }
    }
  }

  return dedupeAddressEvidence(evidence);
}

// One physical address is one opportunity, owned by exactly one blockface.
// OSM commonly carries the same address twice — an address node inside a
// building that repeats the tags — and occasionally places the two on different
// streets. Emitting both would double-count doors and breaks the contract's
// exclusive-ownership guarantee, so addresses are collapsed by key and the
// strongest association wins.
export function dedupeAddressEvidence(evidence) {
  const strength = (record) => (record.associations[0].method === 'address_street' ? 0 : 1);
  const distance = (record) => Number(record.associations[0].distance_m ?? 0);

  const byKey = new Map();
  const passthrough = [];
  for (const record of evidence) {
    if (record.kind !== 'address') {
      passthrough.push(record);
      continue;
    }
    const key = record.attributes.address_key;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, record);
      continue;
    }
    // Union the units, and let a stated occupancy beat an unknown one.
    const units = [...new Set([...existing.attributes.unit_keys, ...record.attributes.unit_keys])].sort();
    const occupancy = existing.attributes.occupancy !== 'unknown'
      ? existing.attributes.occupancy
      : record.attributes.occupancy;
    const winner = strength(record) < strength(existing) ? record
      : strength(record) > strength(existing) ? existing
        : distance(record) < distance(existing) ? record : existing;
    byKey.set(key, {
      ...winner,
      attributes: { ...winner.attributes, unit_keys: units, occupancy },
    });
  }
  return [...passthrough, ...byKey.values()];
}

/* ────────────────────────────── cli ────────────────────────────── */

function parseArguments(argv) {
  const result = {};
  const keys = new Map([
    ['--pbf', 'pbf'], ['--bbox', 'bbox'], ['--tile-key', 'tileKey'],
    ['--source-id', 'sourceId'], ['--dataset-version', 'datasetVersion'],
    ['--license', 'license'], ['--observed-at', 'observedAt'], ['--output', 'output'],
    ['--provider', 'provider'], ['--grid', 'grid'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') return { help: true };
    const key = keys.get(argv[index]);
    if (!key) throw new Error(`Unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    result[key] = value;
    index += 1;
  }
  for (const required of ['pbf', 'bbox', 'tileKey', 'sourceId', 'datasetVersion', 'license', 'observedAt', 'output']) {
    if (!result[required]) throw new Error(`Missing required option: --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return result;
}

export async function compileOsmSourceTiles(options) {
  const [minLng, minLat, maxLng, maxLat] = String(options.bbox).split(',').map(Number);
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) throw new Error('--bbox must be minLng,minLat,maxLng,maxLat');
  const bounds = { min_lng: minLng, min_lat: minLat, max_lng: maxLng, max_lat: maxLat };

  const provenanceOf = (featureId) => ([{
    source_id: options.sourceId,
    dataset_version: options.datasetVersion,
    feature_id: featureId,
    observed_at: options.observedAt,
    license: options.license,
  }]);

  const { nodeCoords, taggedNodes, ways } = await readExtract(options.pbf, bounds);
  const { segments, byEndpoint } = buildRoadSegments(ways, nodeCoords, bounds, provenanceOf);
  if (!segments.length) throw new Error('No road segments fell inside the bounding box.');
  const protectedGroups = buildProtectedGroups(segments, byEndpoint);
  const evidence = buildEvidence(ways, taggedNodes, segments, nodeCoords, provenanceOf);

  // Tile granularity is driven by byte density, not by area. A square mile of
  // dense rowhouses blows the canonical tile limit while a square mile of
  // farmland would not, so the caller splits the request into a grid and each
  // cell declares the bounds it actually holds. Clipping geometry to a cell
  // instead would sever street topology at the seam, which tiling must never do.
  // Density varies far too much for a uniform grid: downtown blocks carry ten
  // times the geometry of the outskirts. Cells are therefore subdivided only
  // where they actually exceed a limit, so sparse areas stay whole and dense
  // ones split as far as they need to. The alternative — one grid number chosen
  // by hand — either wastes tiles everywhere or blows the cap downtown.
  const TILE_BYTE_BUDGET = 4_500_000;   // headroom under the 5.5 MB contract limit
  const TILE_UNIT_BUDGET = 4_500;       // headroom under the 5,000 work-unit limit
  // Depth is relative to the ROOT box, so the same number buys very different
  // leaves: depth 8 over a county reaches ~200 m cells, but over a whole state
  // it stops at ~2 km and emits tiles far past budget. Recursion still halts on
  // the degenerate-quadrant check below, so this is a safety valve, not a target.
  const MAX_SUBDIVISION_DEPTH = 14;

  // A tile's weight is its segments PLUS the evidence that references them —
  // dense blocks carry far more addresses per metre of street, and sizing on
  // geometry alone under-counts exactly where it matters most.
  const evidenceBytesBySegment = new Map();
  for (const record of evidence) {
    const identity = record.associations[0]?.road_identity;
    if (!identity) continue;
    const key = `${identity.source_feature_id}#${identity.segment_index}`;
    evidenceBytesBySegment.set(key, (evidenceBytesBySegment.get(key) || 0) + JSON.stringify(record).length);
  }
  // Protected groups ride along in the emitted tile and were missing from the
  // weight entirely. A county carries few enough for that to go unnoticed; a
  // state carries hundreds of thousands, and the omission put real tiles at
  // nearly twice the budget they were sized against.
  for (const group of protectedGroups) {
    const identity = group.members[0];
    if (!identity) continue;
    const key = `${identity.source_feature_id}#${identity.segment_index}`;
    evidenceBytesBySegment.set(key, (evidenceBytesBySegment.get(key) || 0) + JSON.stringify(group).length);
  }
  const segmentBytes = new Map(segments.map((segment) => {
    const geometryBytes = JSON.stringify({
      ...segment,
      _startRef: undefined, _endRef: undefined, _refs: undefined, _streetName: undefined, _coordPoints: undefined,
    }).length;
    const key = `${segment.identity.source_feature_id}#${segment.identity.segment_index}`;
    return [segment, geometryBytes + (evidenceBytesBySegment.get(key) || 0)];
  }));
  const midpointOf = (segment) => segment._coordPoints[Math.floor(segment._coordPoints.length / 2)];

  const leaves = [];
  const subdivide = (members, box, depth) => {
    if (!members.length) return;
    const bytes = members.reduce((sum, segment) => sum + segmentBytes.get(segment), 0);
    if (depth >= MAX_SUBDIVISION_DEPTH || (bytes <= TILE_BYTE_BUDGET && members.length <= TILE_UNIT_BUDGET)) {
      leaves.push(members);
      return;
    }
    const midLng = (box.minLng + box.maxLng) / 2;
    const midLat = (box.minLat + box.maxLat) / 2;
    const quadrants = [[], [], [], []];
    for (const segment of members) {
      const point = midpointOf(segment);
      quadrants[(point.lat >= midLat ? 2 : 0) + (point.lng >= midLng ? 1 : 0)].push(segment);
    }
    // A quadrant that swallowed everything cannot be split further usefully.
    if (quadrants.some((quadrant) => quadrant.length === members.length)) {
      leaves.push(members);
      return;
    }
    const boxes = [
      { minLng: box.minLng, minLat: box.minLat, maxLng: midLng, maxLat: midLat },
      { minLng: midLng, minLat: box.minLat, maxLng: box.maxLng, maxLat: midLat },
      { minLng: box.minLng, minLat: midLat, maxLng: midLng, maxLat: box.maxLat },
      { minLng: midLng, minLat: midLat, maxLng: box.maxLng, maxLat: box.maxLat },
    ];
    quadrants.forEach((quadrant, index) => subdivide(quadrant, boxes[index], depth + 1));
  };
  subdivide(segments, { minLng, minLat, maxLng, maxLat }, 0);

  const segmentsByCell = new Map();
  const cellBySegmentKey = new Map();
  leaves.forEach((members, index) => {
    const cell = String(index).padStart(4, '0');
    segmentsByCell.set(cell, members);
    for (const segment of members) {
      cellBySegmentKey.set(`${segment.identity.source_feature_id}#${segment.identity.segment_index}`, cell);
    }
  });

  // Evidence belongs to the tile that owns the road it references; the contract
  // rejects an association pointing outside its own tile.
  const evidenceByCell = new Map();
  for (const record of evidence) {
    const identity = record.associations[0].road_identity;
    const cell = cellBySegmentKey.get(`${identity.source_feature_id}#${identity.segment_index}`);
    if (!cell) continue;
    if (!evidenceByCell.has(cell)) evidenceByCell.set(cell, []);
    evidenceByCell.get(cell).push(record);
  }

  const groupsByCell = new Map();
  for (const group of protectedGroups) {
    const identity = group.members[0];
    const cell = cellBySegmentKey.get(`${identity.source_feature_id}#${identity.segment_index}`);
    if (!cell) continue;
    if (!groupsByCell.has(cell)) groupsByCell.set(cell, []);
    groupsByCell.get(cell).push(group);
  }

  // Tiles are yielded, not accumulated. Holding every finished tile alongside
  // the segments they were copied from roughly doubled peak memory at exactly
  // the moment it was highest, and each cell's inputs are dead the instant its
  // tile is written — so they are dropped here rather than at the end of the
  // run. The consumer writes one line at a time, so nothing needs the whole set.
  const orderedCells = [...segmentsByCell.keys()].sort((a, b) => a.localeCompare(b));
  const tileCount = orderedCells.length;
  const coverageBounds = { min_lng: Infinity, min_lat: Infinity, max_lng: -Infinity, max_lat: -Infinity };
  function* generateTiles() {
    for (const cell of orderedCells) {
      const cellSegments = segmentsByCell.get(cell);
      const declared = { min_lng: Infinity, min_lat: Infinity, max_lng: -Infinity, max_lat: -Infinity };
      for (const segment of cellSegments) {
        for (const [lng, lat] of segment.geometry.coordinates) {
          declared.min_lng = Math.min(declared.min_lng, lng);
          declared.max_lng = Math.max(declared.max_lng, lng);
          declared.min_lat = Math.min(declared.min_lat, lat);
          declared.max_lat = Math.max(declared.max_lat, lat);
        }
      }
      const widthMeters = haversineMeters({ lat: declared.min_lat, lng: declared.min_lng }, { lat: declared.min_lat, lng: declared.max_lng });
      const heightMeters = haversineMeters({ lat: declared.min_lat, lng: declared.min_lng }, { lat: declared.max_lat, lng: declared.min_lng });
      const tile = {
        schema: 'firstknock.canvas-source-evidence-tile',
        schema_version: 1,
        tile_address: {
          scheme: 'osm-bbox',
          scheme_version: 1,
          key: tileCount === 1 ? options.tileKey : `${options.tileKey}-${cell}`,
        },
        coverage: {
          area_sq_mi: Number(Math.max(1e-6, (widthMeters * heightMeters) / 2_589_988.11).toFixed(6)),
          bounds: declared,
        },
        road_segments: cellSegments.map(({ _startRef, _endRef, _refs, _streetName, _coordPoints, ...segment }) => segment),
        evidence: evidenceByCell.get(cell) || [],
        protected_groups: groupsByCell.get(cell) || [],
      };
      coverageBounds.min_lng = Math.min(coverageBounds.min_lng, declared.min_lng);
      coverageBounds.min_lat = Math.min(coverageBounds.min_lat, declared.min_lat);
      coverageBounds.max_lng = Math.max(coverageBounds.max_lng, declared.max_lng);
      coverageBounds.max_lat = Math.max(coverageBounds.max_lat, declared.max_lat);
      segmentsByCell.delete(cell);
      evidenceByCell.delete(cell);
      groupsByCell.delete(cell);
      yield tile;
    }
  }

  return {
    tiles: generateTiles(),
    stats: {
      tiles: tileCount,
      segments: segments.length,
      evidence: evidence.length,
      protectedGroups: protectedGroups.length,
      nodesHeld: nodeCoords.size,
      coverageBounds,
    },
  };

}

// A state-sized extract overruns two separate limits here. Writing without
// awaiting drain buffers the whole compile in memory, and a single output file
// stops accepting writes at exactly 2^32 bytes — the Maryland compile died with
// an opaque "A system error occurred" on a file of precisely 4294967296 bytes.
// Parts keep each file well under that wall, and normalize-source already
// accepts repeated --input or a directory, so the split costs nothing later.
//
// Splitting the OUTPUT is safe; splitting the COMPILE is not. Segment identities
// are only stable when one run observes a way's full node list, so an extract
// must be compiled in a single pass no matter how many files it lands in.
const OUTPUT_PART_BYTE_LIMIT = 1_000_000_000;

async function writeTileParts(outputPath, tiles) {
  const base = resolve(outputPath);
  const extension = extname(base);
  const stem = base.slice(0, base.length - extension.length);
  const paths = [];
  let stream = null;
  let failure = null;
  let bytesInPart = 0;

  const openPart = () => {
    const index = paths.length + 1;
    const path = index === 1 ? base : `${stem}.part${String(index).padStart(4, '0')}${extension}`;
    paths.push(path);
    bytesInPart = 0;
    const opened = createWriteStream(path, { encoding: 'utf8' });
    opened.on('error', (error) => { failure = failure || error; });
    return opened;
  };
  const finishPart = (target) => new Promise((resolveFinish, rejectFinish) => {
    target.on('error', rejectFinish);
    target.on('finish', () => (failure ? rejectFinish(failure) : resolveFinish()));
    target.end();
  });

  stream = openPart();
  for (const tile of tiles) {
    if (failure) throw failure;
    const line = `${JSON.stringify(tile)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (bytesInPart > 0 && bytesInPart + lineBytes > OUTPUT_PART_BYTE_LIMIT) {
      await finishPart(stream);
      stream = openPart();
    }
    bytesInPart += lineBytes;
    if (!stream.write(line)) {
      // Both listeners are removed on settle. Leaving the loser attached leaks
      // one listener per drain, which a state-sized compile hits thousands of
      // times over.
      const current = stream;
      await new Promise((resolveDrain, rejectDrain) => {
        const onDrain = () => { current.off('error', onError); resolveDrain(); };
        const onError = (error) => { current.off('drain', onDrain); rejectDrain(error); };
        current.once('drain', onDrain);
        current.once('error', onError);
      });
    }
  }
  await finishPart(stream);
  return paths;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const { tiles, stats } = await compileOsmSourceTiles(options);
    await mkdir(dirname(resolve(options.output)), { recursive: true });
    // NDJSON, one source-evidence tile per line, which normalize-source accepts.
    // Written a line at a time: joining a county's worth of tiles into a single
    // string exceeds V8's maximum string length and fails the entire compile.
    const parts = await writeTileParts(options.output, tiles);
    for (const part of parts) process.stdout.write(`Wrote ${part}\n`);
    // Coverage for the release descriptor must be the union of what was
    // actually emitted, not the requested bbox: Geofabrik ships complete ways
    // across a region's border, so real geometry reaches past the .poly extent.
    // Writing it here is free — the bounds were computed per tile anyway —
    // and saves the orchestrator a second full pass over multi-GB output.
    const summaryPath = `${resolve(options.output)}.summary.json`;
    await writeFile(summaryPath, `${JSON.stringify({
      schema: 'firstknock.canvas-source-evidence-summary',
      schema_version: 1,
      tile_key: options.tileKey,
      parts: parts.map((part) => part.slice(dirname(part).length + 1)),
      coverage_bounds: stats.coverageBounds,
      tiles: stats.tiles,
      road_segments: stats.segments,
      evidence_records: stats.evidence,
      protected_groups: stats.protectedGroups,
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(`Wrote ${summaryPath}\n`);
    process.stdout.write(`  tiles           : ${stats.tiles}\n`);
    process.stdout.write(`  road segments   : ${stats.segments}\n`);
    process.stdout.write(`  evidence records: ${stats.evidence}\n`);
    process.stdout.write(`  protected groups: ${stats.protectedGroups}\n`);
    // Node count is the figure that decides whether an extract fits: a single
    // V8 Map caps out near 16.7M entries, which is why the store is sharded.
    process.stdout.write(`  nodes held      : ${stats.nodesHeld}\n`);
    process.stdout.write(`  peak rss mb     : ${Math.round(process.memoryUsage().rss / 1048576)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}
