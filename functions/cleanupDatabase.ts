import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    // Get current size and counts
    const countBefore = await sql`SELECT COUNT(*) as count FROM properties`;
    
    const tableSizes = await sql`
      SELECT 
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size,
        n_live_tup as row_count
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `;

    const dbSize = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;

    return Response.json({
      database_size: dbSize[0]?.size,
      property_count: parseInt(countBefore[0].count),
      tables: tableSizes,
      message: "Call with action='delete_all' to clear properties table"
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});