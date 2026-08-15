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

    const { zipCode, mode = 'centroid' } = await req.json();
    
    if (!zipCode) {
      return Response.json({ error: 'zipCode required' }, { status: 400 });
    }
    
    // Check if zip_codes table has coordinates for this zip
    const zipData = await sql`
      SELECT latitude, longitude FROM zip_codes WHERE code = ${zipCode} LIMIT 1
    `;
    
    if (zipData.length === 0 || !zipData[0].latitude) {
      return Response.json({ 
        error: 'Zip code not found in reference table or missing coordinates',
        suggestion: 'Need to populate zip_codes table with lat/lng data'
      }, { status: 404 });
    }
    
    const centerLat = parseFloat(zipData[0].latitude);
    const centerLng = parseFloat(zipData[0].longitude);
    
    // Update all properties in this zip to use centroid + small random offset
    // This spreads points around the zip center for visualization
    const result = await sql`
      UPDATE properties 
      SET 
        latitude = ${centerLat} + (random() - 0.5) * 0.02,
        longitude = ${centerLng} + (random() - 0.5) * 0.02
      WHERE zip_code = ${zipCode} 
        AND (latitude IS NULL OR longitude IS NULL)
    `;
    
    // Get updated stats
    const stats = await sql`
      SELECT 
        COUNT(*) as total,
        COUNT(latitude) as with_coords
      FROM properties 
      WHERE zip_code = ${zipCode}
    `;
    
    return Response.json({
      success: true,
      zipCenter: { lat: centerLat, lng: centerLng },
      zipStats: {
        total: parseInt(stats[0].total),
        withCoordinates: parseInt(stats[0].with_coords)
      }
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
