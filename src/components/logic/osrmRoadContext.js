/**
 * osrmRoadContext — road-aware routing context backed by the self-hosted
 * full-USA OSRM instance.
 *
 * This is the piece that makes precision generation work in every US market
 * rather than only where an Overpass query happens to succeed. It produces the
 * same frozen context shape as routeRoadContext's Overpass path, so the 2,000-line
 * optimizer does not change: it keeps calling the synchronous
 * routingContext.distanceBetween() and simply gets road distances instead of
 * straight lines.
 *
 * The scaling problem and how it is solved
 * ----------------------------------------
 * A 25,000-door pull is ~1,000-4,000 distinct street blocks. A dense road matrix
 * over 4,000 blocks is 16,000,000 cells — hundreds of megabytes of JSON, far past
 * any sane request. Naively chunking only the source rows (which an earlier draft
 * did) still asks for 400 x 4,000 blocks with all 4,000 coordinates repeated in
 * every URL, which blows the URL length limit and times out.
 *
 * Instead we exploit the fact that the optimizer only needs *local* precision.
 * Doors collapse onto street blocks; blocks are k-d tiled into compact groups of
 * <= 180; each tile gets one exact dense road matrix; and cross-tile hops — which
 * are long-haul and rare in a finished route — use the aerial distance scaled by
 * the detour factor actually observed between those two tiles. That factor is
 * measured from OSRM, not assumed, so a river with one bridge inflates crossings
 * over it without any hand-tuned constant.
 *
 * Cost for 4,000 blocks: ~23 tile requests + 1 tile-representative request,
 * ~750k cells total. Against 16,000,000 for the dense matrix.
 */

import {
  getTable,
  getOsrmCounters,
  isOsrmConfigured,
  checkOsrmHealth,
  MAX_COORDS_PER_REQUEST,
} from '@/services/osrmClient';
import { canonicalStreetRoutingKey } from './routeOptimizer';

const METERS_PER_MILE = 1609.344;
const EARTH_RADIUS_METERS = 6371008.8;

/** Leaves room under MAX_COORDS_PER_REQUEST for the URL's other parameters. */
const MAX_TILE_SIZE = 180;

/** Concurrent /table calls. The whole point of one droplet is that it is one droplet. */
const REQUEST_CONCURRENCY = 4;

/** Above this, stop and let the caller decide — silently issuing 500 requests is worse. */
const MAX_TILES = 240;

/** Detour factor bounds. Below 1.0 is impossible; above 4.0 is a snapping artifact. */
const MIN_DETOUR_FACTOR = 1.0;
const MAX_DETOUR_FACTOR = 4.0;
const DEFAULT_DETOUR_FACTOR = 1.3;

function pointFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function haversineMeters(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function propertyIdentity(property, fallbackIndex = 0) {
  return String(
    property?.id
    ?? property?.property_id
    ?? property?.address_hash
    ?? `idx:${fallbackIndex}`,
  );
}

/**
 * Collapse doors onto street blocks. Work then scales with block count, not door
 * count, which is what keeps a 25k-door pull road-aware instead of dropping to
 * aerial distance — the original "zigzag".
 */
function buildBlockPlan(properties) {
  const blockByKey = new Map();
  const blockKeyByIdentity = new Map();

  properties.forEach((property, index) => {
    const point = pointFrom(property);
    if (!point) return;
    const key = canonicalStreetRoutingKey(property, index);
    const identity = propertyIdentity(property, index);
    blockKeyByIdentity.set(identity, key);

    let block = blockByKey.get(key);
    if (!block) {
      block = { key, index: blockByKey.size, points: [], sumLat: 0, sumLng: 0 };
      blockByKey.set(key, block);
    }
    block.points.push(point);
    block.sumLat += point.lat;
    block.sumLng += point.lng;
  });

  const blocks = Array.from(blockByKey.values());
  blocks.forEach((block) => {
    const n = block.points.length;
    const centroid = { lat: block.sumLat / n, lng: block.sumLng / n };
    // Snap the centroid to the nearest real door. A block's mean point can land
    // in a back yard or across a highway; a real address always snaps to the
    // road that actually serves it.
    let best = block.points[0];
    let bestDist = Infinity;
    for (const point of block.points) {
      const d = haversineMeters(centroid, point);
      if (d < bestDist) { bestDist = d; best = point; }
    }
    block.representative = best;
  });

  return { blocks, blockKeyByIdentity };
}

/**
 * Recursive median split on the wider axis until every leaf fits one request.
 * Produces compact, roughly equal-sized tiles — which matters because tile
 * compactness is what makes the cross-tile approximation safe.
 */
function kdTile(blocks, maxTileSize) {
  const tiles = [];
  const stack = [blocks];

  while (stack.length) {
    const group = stack.pop();
    if (group.length <= maxTileSize) {
      if (group.length) tiles.push(group);
      continue;
    }
    let minLat = Infinity; let maxLat = -Infinity;
    let minLng = Infinity; let maxLng = -Infinity;
    for (const block of group) {
      const { lat, lng } = block.representative;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    // Longitude degrees shrink with latitude; compare true ground extents or
    // tiles come out stretched east-west in the north.
    const latSpan = maxLat - minLat;
    const lngSpan = (maxLng - minLng) * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const axis = lngSpan > latSpan ? 'lng' : 'lat';

    const sorted = [...group].sort((a, b) => a.representative[axis] - b.representative[axis]);
    const mid = Math.floor(sorted.length / 2);
    stack.push(sorted.slice(0, mid));
    stack.push(sorted.slice(mid));
  }

  tiles.forEach((tile, tileIndex) => {
    tile.forEach((block) => { block.tile = tileIndex; });
  });
  return tiles;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clampFactor(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_DETOUR_FACTOR, Math.max(MIN_DETOUR_FACTOR, value));
}

/**
 * Fetch everything OSRM knows about this property set and return it as plain,
 * structured-cloneable data.
 *
 * Kept separate from context construction because the large-route path optimizes
 * inside a Web Worker, and a frozen object full of closures cannot cross that
 * boundary. The payload can: postMessage it into the worker and rehydrate with
 * hydrateOsrmRoadContext(). That is what lets the worker path be road-aware
 * without an async rewrite of the optimizer.
 *
 * Returns null rather than throwing when OSRM cannot serve the request — the
 * caller's job is to fall through to Overpass and then aerial, and a null keeps
 * that chain readable.
 */
export async function createOsrmContextPayload(properties, options = {}) {
  const {
    signal = null,
    maxTiles = MAX_TILES,
    maxTileSize = Math.min(MAX_TILE_SIZE, MAX_COORDS_PER_REQUEST),
    skipHealthCheck = false,
  } = options;

  if (!isOsrmConfigured()) return null;

  const validProperties = (Array.isArray(properties) ? properties : [])
    .filter((property) => pointFrom(property));
  if (validProperties.length < 2) return null;

  if (!skipHealthCheck) {
    const health = await checkOsrmHealth({ signal });
    if (!health.healthy) {
      console.warn(`[osrmRoadContext] OSRM unhealthy (${health.reason}); deferring to Overpass/aerial.`);
      return null;
    }
  }

  const { blocks, blockKeyByIdentity } = buildBlockPlan(validProperties);
  if (blocks.length < 2) return null;

  const tiles = kdTile(blocks, maxTileSize);
  if (tiles.length > maxTiles) {
    console.warn(
      `[osrmRoadContext] ${blocks.length} street blocks would need ${tiles.length} requests `
      + `(limit ${maxTiles}). Narrow the working area or raise maxTiles deliberately.`,
    );
    return null;
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + (options.deadlineMs || 180_000);

  // --- Pass 1: exact dense road matrix inside each tile ----------------------
  const tileMatrices = await mapWithConcurrency(tiles, REQUEST_CONCURRENCY, async (tile) => {
    if (tile.length < 2) return null;
    try {
      const { distances } = await getTable(
        tile.map((block) => block.representative),
        { signal, deadlineAt },
      );
      return distances;
    } catch (error) {
      console.warn(`[osrmRoadContext] tile matrix failed (${tile.length} blocks): ${error.message}`);
      return null;
    }
  });

  const succeededTiles = tileMatrices.filter(Boolean).length;
  if (succeededTiles === 0) {
    console.warn('[osrmRoadContext] every tile matrix failed; deferring to Overpass/aerial.');
    return null;
  }

  // --- Pass 2: tile-to-tile road distances ----------------------------------
  // One representative per tile. This is what carries barrier knowledge — a river
  // with a single bridge shows up here as a large road/aerial ratio, and every
  // cross-tile estimate over that river inherits it.
  const tileReps = tiles.map((tile) => tile[0].representative);
  let tileRepDistances = null;
  if (tileReps.length >= 2 && tileReps.length <= MAX_COORDS_PER_REQUEST) {
    try {
      ({ distances: tileRepDistances } = await getTable(tileReps, { signal, deadlineAt }));
    } catch (error) {
      console.warn(`[osrmRoadContext] tile-representative matrix failed: ${error.message}`);
    }
  }

  // --- Calibrate the detour factor from measured data -----------------------
  const globalRatios = [];
  const tilePairFactor = new Map();
  if (tileRepDistances) {
    for (let i = 0; i < tileReps.length; i += 1) {
      for (let j = i + 1; j < tileReps.length; j += 1) {
        const road = tileRepDistances[i]?.[j];
        const aerial = haversineMeters(tileReps[i], tileReps[j]);
        if (!Number.isFinite(road) || road === null || aerial < 1) continue;
        const ratio = road / aerial;
        if (!Number.isFinite(ratio) || ratio <= 0) continue;
        globalRatios.push(ratio);
        const factor = clampFactor(ratio, DEFAULT_DETOUR_FACTOR);
        tilePairFactor.set(`${i}|${j}`, factor);
        tilePairFactor.set(`${j}|${i}`, factor);
      }
    }
  }
  const globalDetourFactor = clampFactor(medianOf(globalRatios), DEFAULT_DETOUR_FACTOR);

  const placement = [];
  tiles.forEach((tile, tileIndex) => {
    tile.forEach((block, localIndex) => {
      placement.push([block.key, tileIndex, localIndex]);
    });
  });

  return {
    version: 1,
    blocks: blocks.map((block) => ({
      key: block.key,
      lat: block.representative.lat,
      lng: block.representative.lng,
    })),
    identityToBlockKey: Array.from(blockKeyByIdentity.entries()),
    placement,
    tileMatrices,
    tilePairFactor: Array.from(tilePairFactor.entries()),
    globalDetourFactor,
    stats: {
      originalPointCount: validProperties.length,
      representativeBlockCount: blocks.length,
      tileCount: tiles.length,
      tilesResolved: succeededTiles,
      tileRepMatrixResolved: Boolean(tileRepDistances),
      maxTileSize,
      detourSamples: globalRatios.length,
      buildMs: Date.now() - startedAt,
    },
  };
}

/**
 * Rebuild the synchronous routing context from a payload. Pure and fast — no
 * network, no async — so it is safe to call inside a Web Worker.
 */
export function hydrateOsrmRoadContext(payload) {
  if (!payload || payload.version !== 1) return null;

  const {
    blocks: rawBlocks,
    identityToBlockKey,
    placement,
    tileMatrices,
    tilePairFactor: rawTilePairFactor,
    globalDetourFactor,
    stats,
  } = payload;

  const blockByKey = new Map(
    rawBlocks.map((block) => [
      block.key,
      { key: block.key, representative: { lat: block.lat, lng: block.lng } },
    ]),
  );
  const blockKeyByIdentity = new Map(identityToBlockKey);
  const tilePairFactor = new Map(rawTilePairFactor);
  const tileLocalIndex = new Map(
    placement.map(([key, tileIndex, localIndex]) => [key, { tileIndex, localIndex }]),
  );

  let exactLookups = 0;
  let approximatedLookups = 0;
  let unresolvedLookups = 0;

  const blockFor = (value, fallbackIndex = 0) => {
    if (!value || typeof value !== 'object') return null;
    const identity = propertyIdentity(value, fallbackIndex);
    const key = blockKeyByIdentity.get(identity) || canonicalStreetRoutingKey(value, fallbackIndex);
    return blockByKey.get(key) || null;
  };

  function metersBetween(left, right) {
    const leftPoint = pointFrom(left);
    const rightPoint = pointFrom(right);
    if (!leftPoint || !rightPoint) {
      unresolvedLookups += 1;
      return 0;
    }

    const aerial = haversineMeters(leftPoint, rightPoint);
    const leftBlock = blockFor(left);
    const rightBlock = blockFor(right);

    // Same street block: doors are metres apart on one street. The straight line
    // IS the walk; a road query here would add error, not remove it.
    if (leftBlock && rightBlock && leftBlock.key === rightBlock.key) {
      exactLookups += 1;
      return aerial;
    }

    if (leftBlock && rightBlock) {
      const leftPos = tileLocalIndex.get(leftBlock.key);
      const rightPos = tileLocalIndex.get(rightBlock.key);

      if (leftPos && rightPos && leftPos.tileIndex === rightPos.tileIndex) {
        const matrix = tileMatrices[leftPos.tileIndex];
        const exact = matrix?.[leftPos.localIndex]?.[rightPos.localIndex];
        if (Number.isFinite(exact) && exact !== null) {
          exactLookups += 1;
          // Add the walk from each door to its block representative. Without this
          // every door on a block is treated as standing at the same point.
          return exact
            + haversineMeters(leftPoint, leftBlock.representative)
            + haversineMeters(rightPoint, rightBlock.representative);
        }
      }

      if (leftPos && rightPos) {
        const factor = tilePairFactor.get(`${leftPos.tileIndex}|${rightPos.tileIndex}`);
        approximatedLookups += 1;
        return aerial * (factor || globalDetourFactor);
      }
    }

    approximatedLookups += 1;
    return aerial * globalDetourFactor;
  }

  const diagnostics = Object.freeze({
    engine: 'osrm',
    reason: 'OSRM_ROAD_MATRIX',
    mode: 'cost-only',
    requestedMode: 'cost-only',
    road_network_used: true,
    ...stats,
    globalDetourFactor: Number(globalDetourFactor.toFixed(3)),
    get exactLookupCount() { return exactLookups; },
    get approximatedLookupCount() { return approximatedLookups; },
    get unresolvedLookupCount() { return unresolvedLookups; },
    // The share of distance queries answered from a measured road matrix rather
    // than a scaled straight line. This is the honest quality number for a run —
    // surface it, do not average it away.
    get exactLookupShare() {
      const total = exactLookups + approximatedLookups;
      return total ? Number((exactLookups / total).toFixed(4)) : 0;
    },
    get osrmCounters() { return getOsrmCounters(); },
  });

  return Object.freeze({
    status: stats.tilesResolved === stats.tileCount ? 'ready' : 'partial',
    source: 'osrm-self-hosted-usa',
    roadAware: true,
    // Geometry is not prefetched — the driven polyline depends on the order the
    // optimizer has not produced yet. Call buildOsrmRouteGeometry() after
    // optimization for display mileage and the drawn line.
    costOnly: true,
    mode: 'cost-only',
    distanceBetween(left, right) {
      return metersBetween(left, right) / METERS_PER_MILE;
    },
    distanceBetweenMeters(left, right) {
      return metersBetween(left, right);
    },
    streetSegmentKey(property) {
      const block = blockFor(property);
      return block ? block.key : canonicalStreetRoutingKey(property);
    },
    accessGroupKey(property) {
      // Tile membership is a measured proxy for "reachable without a long detour",
      // which is exactly what an access group is meant to express.
      const block = blockFor(property);
      if (!block) return '';
      const position = tileLocalIndex.get(block.key);
      return position ? `OSRM_TILE:${position.tileIndex}` : '';
    },
    diagnostics,
  });
}

/**
 * Fetch and build in one step — the ordinary main-thread path.
 * Returns null when OSRM cannot serve the request, so callers can fall through.
 */
export async function createOsrmRoadContext(properties, options = {}) {
  const payload = await createOsrmContextPayload(properties, options);
  return payload ? hydrateOsrmRoadContext(payload) : null;
}

/**
 * Post-optimization: the real driven polyline and true mileage for one finished
 * route. Called at display/export time, when the stop order finally exists.
 */
export async function buildOsrmRouteGeometry(orderedProperties, options = {}) {
  const { getRoute } = await import('@/services/osrmClient');
  const points = (Array.isArray(orderedProperties) ? orderedProperties : [])
    .map((property) => pointFrom(property))
    .filter(Boolean);

  if (points.length < 2) return null;

  // Long routes exceed the per-request waypoint ceiling, so walk them in
  // overlapping legs and stitch. The overlap point is shared, not duplicated.
  const CHUNK = MAX_COORDS_PER_REQUEST;
  const legs = [];
  for (let start = 0; start < points.length - 1; start += CHUNK - 1) {
    legs.push(points.slice(start, start + CHUNK));
  }

  let totalMeters = 0;
  let totalSeconds = 0;
  const path = [];

  for (const leg of legs) {
    try {
      const result = await getRoute(leg, { signal: options.signal, overview: 'full' });
      totalMeters += result.distanceMeters;
      totalSeconds += result.durationSeconds;
      const coords = result.geometry?.coordinates || [];
      coords.forEach(([lng, lat], index) => {
        if (index === 0 && path.length) return;
        path.push({ lat, lng });
      });
    } catch (error) {
      console.warn(`[osrmRoadContext] route geometry leg failed: ${error.message}`);
      return null;
    }
  }

  return {
    distanceMeters: totalMeters,
    distanceMiles: totalMeters / METERS_PER_MILE,
    durationSeconds: totalSeconds,
    path,
    usedFallback: false,
  };
}

export const osrmRoadContextInternals = Object.freeze({
  buildBlockPlan,
  kdTile,
  haversineMeters,
  clampFactor,
  MAX_TILE_SIZE,
  DEFAULT_DETOUR_FACTOR,
});
