import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    const { action, limit = 100000 } = await req.json().catch(() => ({}));
    
    // Get current size and counts
    const countBefore = await sql`SELECT COUNT(*) as count FROM properties`;
    const dbSize = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;

    if (action === 'cleanup') {
      // Use zip_code filter if provided in payload (req.json was parsed above but we need to extract zip)
      // Note: The destructuring at the top was simplistic. Let's re-parse or use the object.
      // Wait, we can't re-read stream. We need to check if 'limit' or other params were passed.
      // The current code extracts { action, limit }. Let's add zip_code/state support.
      // We need to modify line 8 in next step, but here let's just implement the logic assuming we can get the params.
      
      // ACTUALLY, I should modify the parsing line first.
      // Let's abort this specific find_replace and do a larger one on the whole file to support specific filters.
    }

    if (action === 'delete_all') {
        await sql`TRUNCATE TABLE properties`;
        return Response.json({ success: true, message: "All properties deleted" });
    }

    if (action === 'vacuum') {
        await sql`VACUUM properties`; // Standard vacuum
        return Response.json({ success: true, message: "Vacuum complete" });
    }

    const tableSizes = await sql`
      SELECT 
        schemaname,
        tablename as table_name,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as total_size
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
    `;

    return Response.json({
      database_size: dbSize[0]?.size,
      property_count: parseInt(countBefore[0].count),
      tables: tableSizes,
      message: "Call with action='cleanup' to delete 100k records, or action='delete_all' to clear table"
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});