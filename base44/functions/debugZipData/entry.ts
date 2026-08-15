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

    const { searchParams } = new URL(req.url);
    const testZip = searchParams.get('zip') || '29401';
    
    // Total records in DB
    const totalCount = await sql`SELECT COUNT(*) as count FROM properties`;
    
    // Count how many have coordinates
    const coordStats = await sql`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 END) as with_coords,
        COUNT(CASE WHEN latitude IS NULL OR longitude IS NULL THEN 1 END) as without_coords
      FROM properties
    `;
    
    // State distribution
    const stateDistribution = await sql`
      SELECT state, COUNT(*) as count 
      FROM properties 
      GROUP BY state 
      ORDER BY count DESC 
      LIMIT 10
    `;
    
    // County distribution for any South Carolina properties
    const countyDistribution = await sql`
      SELECT county, COUNT(*) as count 
      FROM properties 
      WHERE state = 'SC'
      GROUP BY county 
      ORDER BY count DESC 
      LIMIT 10
    `;
    
    // Zip code distribution for test zip
    const zipExactCount = await sql`
      SELECT COUNT(*) as count 
      FROM properties 
      WHERE zip_code = ${testZip}
    `;
    
    // Check zip_codes table
    const zipCodesTable = await sql`
      SELECT COUNT(*) as count FROM zip_codes
    `;
    
    // Check if test zip exists in zip_codes
    const zipCodeEntry = await sql`
      SELECT * FROM zip_codes WHERE code = ${testZip}
    `;
    
    // Sample some properties from the test zip
    const sampleProps = await sql`
      SELECT id, address, city, state, zip_code, latitude, longitude
      FROM properties 
      WHERE zip_code = ${testZip}
      LIMIT 10
    `;
    
    // Check distinct zip codes in a county (e.g., Charleston)
    const charlestonZips = await sql`
      SELECT DISTINCT zip_code, COUNT(*) as count
      FROM properties
      WHERE city ILIKE '%charleston%' OR county ILIKE '%charleston%'
      GROUP BY zip_code
      ORDER BY count DESC
      LIMIT 20
    `;
    
    return Response.json({
      totalRecords: parseInt(totalCount[0].count),
      coordinateStats: coordStats[0],
      topStates: stateDistribution,
      scCounties: countyDistribution,
      testZip: testZip,
      testZipCount: parseInt(zipExactCount[0].count),
      testZipSample: sampleProps,
      zipCodesTableCount: parseInt(zipCodesTable[0].count),
      zipCodeEntry: zipCodeEntry[0] || null,
      charlestonAreaZips: charlestonZips
    });
    
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});
