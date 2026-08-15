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

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
  const nodeCoords = new Map();
  const taggedNodes = [];
  const ways = [];

  await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(pbfPath)
      .pipe(parseOSM())
      .pipe(through.obj((items, _enc, next) => {
        for (const item of items) {
          if (item.type === 'node') {
            if (!insideBounds(item.lat, item.lon, wide)) continue;
            nodeCoords.set(item.id, { lat: item.lat, lng: item.lon });
            const tags = item.tags || {};
            if (tags['addr:housenumber'] || tags.barrier || tags.shop || tags.amenity || tags.office || tags.entrance) {
              taggedNodes.push({ id: item.id, lat: item.lat, lng: item.lon, tags });
            }
          } else if (item.type === 'way') {
            const tags = item.tags || {};
            if (!tags.highway && !tags.building && !tags.landuse && !tags.barrier && !tags.shop && !tags.amenity) continue;
            const coords = (item.refs || []).map((ref) => nodeCoords.get(ref)).filter(Boolean);
            if (!coords.length) continue;
            ways.push({ id: item.id, refs: item.refs || [], tags, coords });
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
      if (insideBounds(midpoint.lat, midpoint.lng, bounds) && coordinates.length >= 2) {
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

function associateToSegment(point, segments, streetName, contextualMethod = null) {
  let best = null;
  for (const segment of segments) {
    const points = segment._coordPoints;
    for (let index = 1; index < points.length; index += 1) {
      const distance = pointToSegmentMeters(point, points[index - 1], points[index]);
      if (distance > MAX_ASSOCIATION_METERS) continue;
      if (!best || distance < best.distance) best = { segment, distance };
    }
  }
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
      }, associateToSegment(point, segments, street));
    } else if (tags.barrier) {
      push(`node/${node.id}`, 'barrier', {
        barrier_type: String(tags.barrier).slice(0, 80),
        pedestrian_access: pedestrianAccessOf(tags),
      }, associateToSegment(point, segments, null, 'network_link'));
    } else if (tags.shop || tags.amenity || tags.office) {
      const placeUse = placeUseOf(tags);
      if (placeUse) {
        push(`node/${node.id}`, 'place', { place_use: placeUse },
          associateToSegment(point, segments, null, 'area_overlap'));
      }
    }
  }

  for (const way of ways) {
    const tags = way.tags;
    const centroid = way.coords.reduce((acc, point) => ({
      lat: acc.lat + point.lat / way.coords.length,
      lng: acc.lng + point.lng / way.coords.length,
    }), { lat: 0, lng: 0 });

    if (tags.building) {
      const use = buildingUseOf(tags);
      if (!use) continue;
      const street = normalizeStreetName(tags['addr:street']);
      const association = associateToSegment(centroid, segments, street);
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
          associateToSegment(centroid, segments, null, 'area_overlap'));
      }
    } else if (tags.shop || tags.amenity) {
      const placeUse = placeUseOf(tags);
      if (placeUse) {
        push(`way/${way.id}`, 'place', { place_use: placeUse },
          associateToSegment(centroid, segments, null, 'area_overlap'));
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
  const gridSize = Math.max(1, Number.parseInt(options.grid ?? '1', 10) || 1);
  const cellOf = (segment) => {
    const points = segment._coordPoints;
    const mid = points[Math.floor(points.length / 2)];
    const col = Math.min(gridSize - 1, Math.floor(((mid.lng - minLng) / (maxLng - minLng)) * gridSize));
    const row = Math.min(gridSize - 1, Math.floor(((mid.lat - minLat) / (maxLat - minLat)) * gridSize));
    return `${Math.max(0, row)}-${Math.max(0, col)}`;
  };

  const segmentsByCell = new Map();
  const cellBySegmentKey = new Map();
  for (const segment of segments) {
    const cell = cellOf(segment);
    if (!segmentsByCell.has(cell)) segmentsByCell.set(cell, []);
    segmentsByCell.get(cell).push(segment);
    cellBySegmentKey.set(`${segment.identity.source_feature_id}#${segment.identity.segment_index}`, cell);
  }

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

  const tiles = [];
  for (const [cell, cellSegments] of [...segmentsByCell].sort(([a], [b]) => a.localeCompare(b))) {
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
    tiles.push({
      schema: 'firstknock.canvas-source-evidence-tile',
      schema_version: 1,
      tile_address: {
        scheme: 'osm-bbox',
        scheme_version: 1,
        key: gridSize === 1 ? options.tileKey : `${options.tileKey}-${cell}`,
      },
      coverage: {
        area_sq_mi: Number(Math.max(1e-6, (widthMeters * heightMeters) / 2_589_988.11).toFixed(6)),
        bounds: declared,
      },
      road_segments: cellSegments.map(({ _startRef, _endRef, _refs, _streetName, _coordPoints, ...segment }) => segment),
      evidence: evidenceByCell.get(cell) || [],
      protected_groups: groupsByCell.get(cell) || [],
    });
  }

  return {
    tiles,
    stats: {
      tiles: tiles.length,
      segments: segments.length,
      evidence: evidence.length,
      protectedGroups: protectedGroups.length,
      nodesHeld: nodeCoords.size,
    },
  };

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
    await writeFile(resolve(options.output), `${tiles.map((tile) => JSON.stringify(tile)).join('\n')}\n`, 'utf8');
    process.stdout.write(`Wrote ${options.output}\n`);
    process.stdout.write(`  tiles           : ${stats.tiles}\n`);
    process.stdout.write(`  road segments   : ${stats.segments}\n`);
    process.stdout.write(`  evidence records: ${stats.evidence}\n`);
    process.stdout.write(`  protected groups: ${stats.protectedGroups}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}
