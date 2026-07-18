import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const EXCLUDED_TYPES = ['park', 'forest', 'school', 'water', 'golf_course', 'industrial', 'commercial'];
const MAX_POLYGON_POINTS = 800;
const MAX_AREA_SQ_MI = 300;
const MAX_RETURNED_OPPORTUNITIES = 5000;
const MAX_RETURNED_EXCLUDED_AREAS = 250;
const COORDINATE_EPSILON = 1e-10;

function samePoint(left, right) {
  return Math.abs(left.lat - right.lat) <= COORDINATE_EPSILON
    && Math.abs(left.lng - right.lng) <= COORDINATE_EPSILON;
}

function normalizePolygon(rawPolygon) {
  if (!Array.isArray(rawPolygon)) return [];
  const parsed = rawPolygon.map((point) => ({
      lat: Number(point?.lat ?? point?.[0]),
      lng: Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1])
    }));
  if (parsed.some((point) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) return [];
  const points = parsed.reduce((result, point) => {
    if (!result.length || !samePoint(result[result.length - 1], point)) result.push(point);
    return result;
  }, []);
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  return points;
}

function orientation(first, second, third) {
  const value = (second.lng - first.lng) * (third.lat - first.lat) - (second.lat - first.lat) * (third.lng - first.lng);
  if (Math.abs(value) <= COORDINATE_EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function pointOnSegment(point, start, end) {
  if (orientation(start, end, point) !== 0) return false;
  return point.lng >= Math.min(start.lng, end.lng) - COORDINATE_EPSILON
    && point.lng <= Math.max(start.lng, end.lng) + COORDINATE_EPSILON
    && point.lat >= Math.min(start.lat, end.lat) - COORDINATE_EPSILON
    && point.lat <= Math.max(start.lat, end.lat) + COORDINATE_EPSILON;
}

function segmentsIntersectInclusive(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  if (firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation) return true;
  return pointOnSegment(secondStart, firstStart, firstEnd)
    || pointOnSegment(secondEnd, firstStart, firstEnd)
    || pointOnSegment(firstStart, secondStart, secondEnd)
    || pointOnSegment(firstEnd, secondStart, secondEnd);
}

function polygonSelfIntersects(points) {
  if (points.length < 4) return false;
  for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
    const firstNextIndex = (firstIndex + 1) % points.length;
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
      const secondNextIndex = (secondIndex + 1) % points.length;
      if (firstNextIndex === secondIndex || secondNextIndex === firstIndex) continue;
      if (segmentsIntersectInclusive(points[firstIndex], points[firstNextIndex], points[secondIndex], points[secondNextIndex])) return true;
    }
  }
  return false;
}

function closePolygon(points) {
  if (!points.length) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.lat - last.lat) < 0.0000001 && Math.abs(first.lng - last.lng) < 0.0000001) return points;
  return [...points, first];
}

function polygonAreaSqMi(points) {
  if (points.length < 3) return 0;
  const avgLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(avgLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({ x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

function polygonToWkt(points) {
  const closed = closePolygon(points);
  const coords = closed.map((point) => `${point.lng} ${point.lat}`).join(', ');
  return `POLYGON((${coords}))`;
}

function normalizeType(value) {
  const type = String(value || 'unknown').toLowerCase();
  if (type === 'golf' || type === 'golf_course' || type === 'golf course') return 'golf_course';
  if (type === 'lake' || type === 'river' || type === 'pond') return 'water';
  if (type === 'parks') return 'park';
  if (type === 'schools') return 'school';
  return type;
}

function toCamelExcluded(type) {
  const normalized = normalizeType(type);
  if (normalized === 'golf_course') return 'golfCourses';
  if (normalized === 'industrial') return 'industrialAreas';
  if (normalized === 'commercial') return 'commercialAreas';
  return `${normalized}s`;
}

function confidenceFor(residentialLandUse) {
  return residentialLandUse ? 'MEDIUM' : 'LOW';
}

function stableDoorIdForBuilding(buildingId) {
  return `building:${String(buildingId)}`;
}

function canManageCanvas(user) {
  const appRole = String(user?.app_role || user?.data?.app_role || '').toLowerCase();
  const accountRole = String(user?.role || user?.data?.role || '').toLowerCase();
  return user?.is_owner === true || appRole === 'manager' || appRole === 'admin' || accountRole === 'manager' || accountRole === 'admin';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!canManageCanvas(user)) {
      return Response.json({ error: 'Manager access required' }, { status: 403 });
    }

    const payload = await req.json();
    if (payload?.self_test) {
      return Response.json({ success: true, mode: 'self_test', service: 'canvasAnalyzeTerritory' });
    }

    const points = normalizePolygon(payload?.polygon);
    if (points.length < 3) {
      return Response.json({ error: 'A valid territory polygon is required' }, { status: 400 });
    }
    if (points.length > MAX_POLYGON_POINTS) {
      return Response.json({ error: `Polygon has too many points. Max ${MAX_POLYGON_POINTS}.` }, { status: 400 });
    }
    if (polygonSelfIntersects(points)) {
      return Response.json({
        error: 'invalid_canvas_boundary',
        message: 'The Canvas boundary crosses or touches itself. Redraw one simple outer boundary before analyzing homes.'
      }, { status: 400 });
    }

    const areaSqMi = polygonAreaSqMi(points);
    if (areaSqMi <= 0) {
      return Response.json({ error: 'invalid_canvas_boundary', message: 'The Canvas boundary has no usable area. Redraw a wider territory.' }, { status: 400 });
    }
    if (areaSqMi > MAX_AREA_SQ_MI) {
      return Response.json({ error: `Territory is too large. Maximum ${MAX_AREA_SQ_MI} square miles.` }, { status: 400 });
    }

    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
      return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
    }

    const sql = neon(databaseUrl);
    const wkt = polygonToWkt(points);
    const analysisId = crypto.randomUUID();
    const startedAt = Date.now();

    const buildingStats = await sql`
      WITH input AS (SELECT ST_SetSRID(ST_GeomFromText(${wkt}), 4326) AS geom),
      candidates AS (
        SELECT b.id, b.geom, ST_PointOnSurface(b.geom) AS center
        FROM building_footprints b, input i
        WHERE ST_Intersects(b.geom, i.geom)
          AND ST_Contains(i.geom, ST_PointOnSurface(b.geom))
        LIMIT 50000
      ),
      classified AS (
        SELECT
          c.id,
          EXISTS (
            SELECT 1 FROM land_use l
            WHERE LOWER(l.type) = 'residential'
              AND ST_Intersects(l.geom, c.center)
          ) AS residential_land_use,
          EXISTS (
            SELECT 1 FROM land_use l
            WHERE LOWER(l.type) = ANY(${EXCLUDED_TYPES})
              AND ST_Intersects(l.geom, c.center)
          ) AS excluded
        FROM candidates c
      )
      SELECT
        COUNT(*)::int AS buildings_found,
        COUNT(*) FILTER (WHERE NOT excluded)::int AS opportunities_found,
        COUNT(*) FILTER (WHERE excluded)::int AS buildings_excluded,
        COUNT(*) FILTER (WHERE NOT excluded AND residential_land_use)::int AS medium_confidence,
        COUNT(*) FILTER (WHERE NOT excluded AND NOT residential_land_use)::int AS low_confidence
      FROM classified
    `;

    const summaryRow = buildingStats[0] || {};
    const opportunities = await sql`
      WITH input AS (SELECT ST_SetSRID(ST_GeomFromText(${wkt}), 4326) AS geom),
      candidates AS (
        SELECT b.id, b.geom, ST_PointOnSurface(b.geom) AS center, b.area_sqm
        FROM building_footprints b, input i
        WHERE ST_Intersects(b.geom, i.geom)
          AND ST_Contains(i.geom, ST_PointOnSurface(b.geom))
        LIMIT 50000
      ),
      filtered AS (
        SELECT
          c.id,
          c.area_sqm,
          c.center,
          EXISTS (
            SELECT 1 FROM land_use l
            WHERE LOWER(l.type) = 'residential'
              AND ST_Intersects(l.geom, c.center)
          ) AS residential_land_use
        FROM candidates c
        WHERE NOT EXISTS (
          SELECT 1 FROM land_use l
          WHERE LOWER(l.type) = ANY(${EXCLUDED_TYPES})
            AND ST_Intersects(l.geom, c.center)
        )
      )
      SELECT
        id::text AS building_id,
        ST_Y(center) AS lat,
        ST_X(center) AS lng,
        COALESCE(area_sqm, 0) AS area_sqm,
        residential_land_use
      FROM filtered
      LIMIT ${MAX_RETURNED_OPPORTUNITIES}
    `;

    const excludedRows = await sql`
      WITH input AS (SELECT ST_SetSRID(ST_GeomFromText(${wkt}), 4326) AS geom)
      SELECT
        LOWER(type) AS type,
        COUNT(*) OVER (PARTITION BY LOWER(type))::int AS type_count,
        name,
        ST_AsGeoJSON(ST_Intersection(l.geom, i.geom)) AS geometry
      FROM land_use l, input i
      WHERE LOWER(l.type) = ANY(${EXCLUDED_TYPES})
        AND ST_Intersects(l.geom, i.geom)
      LIMIT ${MAX_RETURNED_EXCLUDED_AREAS}
    `;

    const excluded = {};
    excludedRows.forEach((row) => {
      const key = toCamelExcluded(row.type);
      excluded[key] = Math.max(excluded[key] || 0, Number(row.type_count) || 0);
    });

    const opportunityPayload = opportunities.map((item) => {
      const classificationConfidence = confidenceFor(item.residential_land_use);
      const opportunityRowId = `opp_${analysisId}_${item.building_id}`;
      const stableDoorId = stableDoorIdForBuilding(item.building_id);
      return {
        // `id` remains the frontend assignment identity for compatibility.
        // The database row id is analysis-scoped provenance and is returned
        // separately so repeated analyses resolve the same building identity.
        id: stableDoorId,
        stableDoorId,
        opportunityRowId,
        buildingId: item.building_id,
        lat: Number(item.lat),
        lng: Number(item.lng),
        areaSqm: Number(item.area_sqm) || 0,
        classificationConfidence,
        discoverySource: 'BUILDING_ONLY'
      };
    });

    const confidence = {
      high: 0,
      medium: Number(summaryRow.medium_confidence) || 0,
      low: Number(summaryRow.low_confidence) || 0
    };

    const included = {
      structures: Number(summaryRow.opportunities_found) || 0
    };

    const diagnostics = {
      areaSqMi: Number(areaSqMi.toFixed(3)),
      buildingsFound: Number(summaryRow.buildings_found) || 0,
      buildingsExcluded: Number(summaryRow.buildings_excluded) || 0,
      returnedOpportunities: opportunityPayload.length,
      returnedExcludedAreas: excludedRows.length,
      processingTimeMs: Date.now() - startedAt,
      opportunityReturnLimit: MAX_RETURNED_OPPORTUNITIES
    };

    await sql`
      INSERT INTO canvas_analysis (id, manager_id, polygon, total_opportunities, included, excluded, confidence, diagnostics)
      VALUES (${analysisId}, ${user.id}, ${JSON.stringify(points)}, ${included.structures}, ${JSON.stringify(included)}, ${JSON.stringify(excluded)}, ${JSON.stringify(confidence)}, ${JSON.stringify(diagnostics)})
    `;

    for (const item of opportunityPayload) {
      await sql`
        INSERT INTO opportunities (id, analysis_id, stable_door_id, geom, building_id, classification_confidence, discovery_source)
        VALUES (${item.opportunityRowId}, ${analysisId}, ${item.stableDoorId}, ST_SetSRID(ST_MakePoint(${item.lng}, ${item.lat}), 4326), ${Number(item.buildingId)}, ${item.classificationConfidence}, ${item.discoverySource})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    const excludedAreas = excludedRows.map((row, index) => ({
      id: `excluded_${analysisId}_${index}`,
      type: normalizeType(row.type),
      name: row.name || normalizeType(row.type).replace('_', ' '),
      geometry: JSON.parse(row.geometry)
    }));

    return Response.json({
      success: true,
      analysisId,
      totalOpportunities: included.structures,
      included,
      excluded,
      confidence,
      opportunities: opportunityPayload,
      excludedAreas,
      diagnostics
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
