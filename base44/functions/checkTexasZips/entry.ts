import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
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