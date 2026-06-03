import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
      return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
    }

    const sql = neon(databaseUrl);

    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;

    await sql`
      CREATE TABLE IF NOT EXISTS building_footprints (
        id BIGSERIAL PRIMARY KEY,
        geom geometry(Geometry, 4326) NOT NULL,
        area_sqm DOUBLE PRECISION,
        source TEXT NOT NULL DEFAULT 'microsoft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS land_use (
        id BIGSERIAL PRIMARY KEY,
        geom geometry(Geometry, 4326) NOT NULL,
        type TEXT NOT NULL,
        osm_id TEXT,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_analysis (
        id TEXT PRIMARY KEY,
        manager_id TEXT,
        polygon JSONB NOT NULL,
        total_opportunities INTEGER NOT NULL DEFAULT 0,
        included JSONB NOT NULL DEFAULT '{}'::jsonb,
        excluded JSONB NOT NULL DEFAULT '{}'::jsonb,
        confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
        manager_feedback TEXT,
        feedback_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL REFERENCES canvas_analysis(id) ON DELETE CASCADE,
        geom geometry(Point, 4326) NOT NULL,
        building_id BIGINT,
        classification_confidence TEXT NOT NULL DEFAULT 'LOW',
        discovery_source TEXT NOT NULL DEFAULT 'BUILDING_ONLY',
        exclusion_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const indexStatements = [
      'CREATE INDEX IF NOT EXISTS idx_building_footprints_geom ON building_footprints USING GIST (geom)',
      'CREATE INDEX IF NOT EXISTS idx_land_use_geom ON land_use USING GIST (geom)',
      'CREATE INDEX IF NOT EXISTS idx_land_use_type ON land_use(type)',
      'CREATE INDEX IF NOT EXISTS idx_canvas_analysis_manager ON canvas_analysis(manager_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_opportunities_analysis ON opportunities(analysis_id)',
      'CREATE INDEX IF NOT EXISTS idx_opportunities_geom ON opportunities USING GIST (geom)'
    ];

    for (const statement of indexStatements) {
      await sql(statement);
    }

    return Response.json({
      success: true,
      message: 'Canvas opportunity discovery tables are ready',
      tables: ['building_footprints', 'land_use', 'canvas_analysis', 'opportunities'],
      indexes_created: indexStatements.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});