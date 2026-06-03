import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
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
      WHERE id = ${analysisId}
      LIMIT 1
    `;

    if (!rows.length) {
      return Response.json({ error: 'Analysis not found' }, { status: 404 });
    }

    const opportunities = await sql`
      SELECT id, building_id::text AS building_id, classification_confidence, discovery_source, ST_Y(geom) AS lat, ST_X(geom) AS lng
      FROM opportunities
      WHERE analysis_id = ${analysisId}
      LIMIT 5000
    `;

    return Response.json({
      success: true,
      analysis: rows[0],
      opportunities: opportunities.map((item) => ({
        id: item.id,
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