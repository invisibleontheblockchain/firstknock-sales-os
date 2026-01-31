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
      // Delete random records to free up space
      await sql`
        DELETE FROM properties 
        WHERE id IN (
          SELECT id FROM properties 
          ORDER BY random() 
          LIMIT ${limit}
        )
      `;
      
      const countAfter = await sql`SELECT COUNT(*) as count FROM properties`;
      
      return Response.json({
        success: true,
        deleted: parseInt(countBefore[0].count) - parseInt(countAfter[0].count),
        remaining: parseInt(countAfter[0].count),
        previous_size: dbSize[0]?.size
      });
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