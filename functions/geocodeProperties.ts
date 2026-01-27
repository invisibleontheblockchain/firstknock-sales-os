import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

// Free geocoding using Nominatim (OpenStreetMap) - 1 request/second limit
async function geocodeAddress(address, zip) {
  try {
    const query = encodeURIComponent(`${address}, ${zip}, USA`);
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      {
        headers: {
          'User-Agent': 'FirstKnock-App/1.0'
        }
      }
    );
    const data = await response.json();
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon)
      };
    }
    return null;
  } catch (e) {
    console.error('Geocode error:', e.message);
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    const { zipCode, batchSize = 50 } = await req.json();
    
    if (!zipCode) {
      return Response.json({ error: 'zipCode required' }, { status: 400 });
    }
    
    // Get properties without coordinates for this zip
    const properties = await sql`
      SELECT id, address, zip_code 
      FROM properties 
      WHERE zip_code = ${zipCode} 
        AND (latitude IS NULL OR longitude IS NULL)
        AND address IS NOT NULL
      LIMIT ${batchSize}
    `;
    
    if (properties.length === 0) {
      // Check how many already have coords
      const existing = await sql`
        SELECT COUNT(*) as count FROM properties 
        WHERE zip_code = ${zipCode} AND latitude IS NOT NULL
      `;
      return Response.json({ 
        message: 'No properties need geocoding',
        alreadyGeocoded: parseInt(existing[0].count)
      });
    }
    
    let geocoded = 0;
    let failed = 0;
    
    for (const prop of properties) {
      // Rate limit: 1 request per second for Nominatim
      await new Promise(r => setTimeout(r, 1100));
      
      const coords = await geocodeAddress(prop.address, prop.zip_code);
      
      if (coords) {
        await sql`
          UPDATE properties 
          SET latitude = ${coords.lat}, longitude = ${coords.lng}
          WHERE id = ${prop.id}
        `;
        geocoded++;
      } else {
        failed++;
      }
    }
    
    // Get updated stats
    const stats = await sql`
      SELECT 
        COUNT(*) as total,
        COUNT(latitude) as with_coords
      FROM properties 
      WHERE zip_code = ${zipCode}
    `;
    
    return Response.json({
      processed: properties.length,
      geocoded,
      failed,
      zipStats: {
        total: parseInt(stats[0].total),
        withCoordinates: parseInt(stats[0].with_coords)
      }
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});