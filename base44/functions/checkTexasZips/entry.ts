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

    const url = new URL(req.url);
    const testZip = url.searchParams.get('zip') || '78747';
    
    // Check Texas zip codes specifically
    const texasZips = await sql`
      SELECT zip_code, city, county, COUNT(*) as count
      FROM properties
      WHERE state = 'TX'
      GROUP BY zip_code, city, county
      ORDER BY count DESC
      LIMIT 30
    `;
    
    // Check for the specific zip
    const specificZip = await sql`
      SELECT zip_code, city, state, county, COUNT(*) as count
      FROM properties
      WHERE zip_code = ${testZip}
      GROUP BY zip_code, city, state, county
    `;
    
    // Sample properties from that zip
    const sampleProps = await sql`
      SELECT id, address, city, state, zip_code, county, latitude, longitude
      FROM properties
      WHERE zip_code = ${testZip}
      LIMIT 10
    `;
    
    // Check zip_codes table
    const zipEntry = await sql`
      SELECT * FROM zip_codes WHERE code = ${testZip}
    `;
    
    // Check all columns in properties table
    const schema = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'properties'
      ORDER BY ordinal_position
    `;
    
    return Response.json({
      testZip,
      specificZipCount: specificZip,
      sampleProperties: sampleProps,
      zipCodeEntry: zipEntry[0] || null,
      texasZipCodes: texasZips,
      propertiesSchema: schema
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
