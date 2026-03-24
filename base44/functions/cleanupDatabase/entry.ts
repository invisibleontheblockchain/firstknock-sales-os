import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = Deno.env.get("DATABASE_URL");
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    const { action, limit = 100000, zip_code, state } = await req.json().catch(() => ({}));
    
    // Get current size and counts
    const countBefore = await sql`SELECT COUNT(*) as count FROM properties`;
    const dbSize = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;

    if (action === 'cleanup') {
      let result;
      
      if (zip_code) {
          // Targeted delete by Zip
          await sql`DELETE FROM properties WHERE zip_code = ${zip_code}`;
          result = { mode: 'zip', target: zip_code };
      } else if (state) {
          // Targeted delete by State
          await sql`DELETE FROM properties WHERE state = ${state}`;
          result = { mode: 'state', target: state };
      } else {
          // Random delete to free up space (fallback)
          await sql`
            DELETE FROM properties 
            WHERE id IN (
              SELECT id FROM properties 
              ORDER BY random() 
              LIMIT ${limit}
            )
          `;
          result = { mode: 'random', limit };
      }
      
      const countAfter = await sql`SELECT COUNT(*) as count FROM properties`;
      
      return Response.json({
        success: true,
        deleted: parseInt(countBefore[0].count) - parseInt(countAfter[0].count),
        remaining: parseInt(countAfter[0].count),
        previous_size: dbSize[0]?.size,
        details: result
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

    // Group counts by State for easier management
    const stateCounts = await sql`
        SELECT state, COUNT(*) as count 
        FROM properties 
        GROUP BY state 
        ORDER BY count DESC
    `;

    return Response.json({
      database_size: dbSize[0]?.size,
      property_count: parseInt(countBefore[0].count),
      tables: tableSizes,
      state_counts: stateCounts,
      message: "Call with action='cleanup' (and optional zip_code/state) to delete records"
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});