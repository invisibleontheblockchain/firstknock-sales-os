import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    // Check if zip_codes table exists
    const tableCheck = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'zip_codes'
      ) as exists
    `;
    
    if (!tableCheck[0].exists) {
      return Response.json({ 
        exists: false,
        message: 'zip_codes table does not exist'
      });
    }
    
    // Get schema
    const schema = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'zip_codes'
      ORDER BY ordinal_position
    `;
    
    // Get count and sample
    const count = await sql`SELECT COUNT(*) as count FROM zip_codes`;
    const sample = await sql`SELECT * FROM zip_codes LIMIT 5`;
    
    // Check how many have coordinates
    const coordStats = await sql`
      SELECT 
        COUNT(*) as total,
        COUNT(latitude) as with_lat,
        COUNT(longitude) as with_lng
      FROM zip_codes
    `;
    
    return Response.json({
      exists: true,
      schema: schema,
      totalRecords: parseInt(count[0].count),
      coordinateStats: coordStats[0],
      sampleRecords: sample
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});