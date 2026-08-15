import { neon } from 'npm:@neondatabase/serverless@0.9.0';

function getDatabaseClient() {
  const databaseUrl = Deno.env.get('DATABASE_URL') || Deno.env.get('NEON_DATABASE_URL');
  return databaseUrl ? neon(databaseUrl) : null;
}

Deno.serve(async (req) => {
  try {
    const sql = getDatabaseClient();
    if (!sql) {
      return Response.json({ error: 'Database connection is not configured on the server.' }, { status: 503 });
    }

    // Find all zip codes in Charleston County SC with their counts
    const charlestonZips = await sql`
      SELECT zip_code, city, county, COUNT(*) as count
      FROM properties
      WHERE county = 'Charleston' AND state = 'SC'
      GROUP BY zip_code, city, county
      ORDER BY count DESC
    `;
    
    // Also find any 294xx zip codes (Charleston area)
    const zip294 = await sql`
      SELECT zip_code, city, state, county, COUNT(*) as count
      FROM properties
      WHERE zip_code LIKE '294%'
      GROUP BY zip_code, city, state, county
      ORDER BY count DESC
      LIMIT 30
    `;
    
    return Response.json({
      charlestonCountyZips: charlestonZips,
      all294Zips: zip294
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
