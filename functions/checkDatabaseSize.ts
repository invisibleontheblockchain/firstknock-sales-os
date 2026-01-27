import { neon } from 'npm:@neondatabase/serverless';

const sql = neon(Deno.env.get('NEON_DATABASE_URL'));

Deno.serve(async (req) => {
  try {
    // Get table sizes
    const tableSizes = await sql`
      SELECT 
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size,
        pg_total_relation_size(relid) as size_bytes,
        n_live_tup as row_count
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `;

    // Get total database size
    const dbSize = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;

    return Response.json({
      database_size: dbSize[0]?.size,
      tables: tableSizes
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});