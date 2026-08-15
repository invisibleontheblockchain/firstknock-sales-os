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

    const { zipCode } = await req.json();
    
    // Check if zip exists in zip_codes table
    const zipRef = await sql`
      SELECT * FROM zip_codes WHERE code = ${zipCode} LIMIT 1
    `;
    
    // Get properties with JOIN
    const withJoin = await sql`
      SELECT 
        p.id, p.address, p.zip_code,
        p.latitude as prop_lat, p.longitude as prop_lng,
        z.latitude as zip_lat, z.longitude as zip_lng,
        COALESCE(p.latitude, z.latitude) as final_lat,
        COALESCE(p.longitude, z.longitude) as final_lng
      FROM properties p
      LEFT JOIN zip_codes z ON p.zip_code = z.code
      WHERE p.zip_code = ${zipCode}
      LIMIT 10
    `;
    
    return Response.json({
      zipCodeReference: zipRef[0] || null,
      propertiesWithJoin: withJoin,
      summary: {
        zipInRefTable: zipRef.length > 0,
        propertiesFound: withJoin.length,
        withCoords: withJoin.filter(p => p.final_lat && p.final_lng).length
      }
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
