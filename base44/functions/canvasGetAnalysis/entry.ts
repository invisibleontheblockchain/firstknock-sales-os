import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

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

    const { analysisId, self_test } = await req.json();
    if (self_test) {
      return Response.json({ success: true, mode: 'self_test', service: 'canvasGetAnalysis' });
    }
    if (!analysisId) {
      return Response.json({ error: 'analysisId is required' }, { status: 400 });
    }

    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
      return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
    }

    const sql = neon(databaseUrl);
    const rows = await sql`
      SELECT id, manager_id, polygon, total_opportunities, included, excluded, confidence, diagnostics, manager_feedback, feedback_notes, created_at, updated_at
      FROM canvas_analysis
      WHERE id = ${analysisId} AND manager_id = ${user.id}
      LIMIT 1
    `;

    if (!rows.length) {
      return Response.json({ error: 'Analysis not found' }, { status: 404 });
    }

    const opportunities = await sql`
      SELECT
        id AS opportunity_row_id,
        stable_door_id,
        building_id::text AS building_id,
        classification_confidence,
        discovery_source,
        ST_Y(geom) AS lat,
        ST_X(geom) AS lng
      FROM opportunities o
      WHERE o.analysis_id = ${analysisId}
        AND EXISTS (
          SELECT 1
          FROM canvas_analysis a
          WHERE a.id = o.analysis_id AND a.manager_id = ${user.id}
        )
      LIMIT 5000
    `;

    return Response.json({
      success: true,
      analysis: rows[0],
      opportunities: opportunities.map((item) => ({
        id: item.stable_door_id,
        stableDoorId: item.stable_door_id,
        opportunityRowId: item.opportunity_row_id,
        buildingId: item.building_id,
        lat: Number(item.lat),
        lng: Number(item.lng),
        classificationConfidence: item.classification_confidence,
        discoverySource: item.discovery_source
      }))
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
