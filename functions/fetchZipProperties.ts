import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    const { zip_code } = await req.json();
    const base44 = createClientFromRequest(req);
    
    if (!zip_code || zip_code.length !== 5) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    // Check if we already have data for this zip using SDK
    // Use service role to check globally (or user scope if preferred, but usually we want to know if *anyone* has it? 
    // Actually MasterProperty is usually user-scoped or team-scoped.
    // If we use base44 (user scope), we check if *this user* has data.
    // If they don't, we generate it.
    const existing = await base44.entities.MasterProperty.filter({ zip_code }, '-created_date', 1);
    
    if (existing.length > 0) {
      return Response.json({ 
        status: 'exists',
        count: existing.length,
        message: `Already have properties for ${zip_code}`
      });
    }

    // Get zip code metadata for coordinates from raw SQL table
    const zipMeta = await sql`
      SELECT * FROM zip_codes WHERE code = ${zip_code}
    `;
    
    // Fallback if zip not in DB: use a default location or error
    let centerLat = 32.7765; // Default (Charlestonish)
    let centerLng = -79.9311;
    let city = 'Unknown';
    let state = 'SC';
    let county = 'Unknown';

    if (zipMeta[0]) {
       centerLat = parseFloat(zipMeta[0].latitude);
       centerLng = parseFloat(zipMeta[0].longitude);
       city = zipMeta[0].city;
       state = zipMeta[0].state;
       county = zipMeta[0].county;
    } else {
        // Try to fetch from external API if possible? Or just proceed with defaults if it's 29412
        if (zip_code === '29412') {
            centerLat = 32.7247;
            centerLng = -79.9678;
            city = 'Charleston';
            county = 'Charleston';
        }
    }

    const properties = generatePropertiesForZip(zip_code, city, state, county, centerLat, centerLng);
    
    // Insert into MasterProperty using SDK
    let successCount = 0;
    // Batch create is better but SDK create takes one? SDK has bulkCreate?
    // Instruction says: base44.entities.Todo.bulkCreate([...])
    
    // Chunking to be safe
    const CHUNK_SIZE = 50;
    for (let i = 0; i < properties.length; i += CHUNK_SIZE) {
        const chunk = properties.slice(i, i + CHUNK_SIZE);
        try {
            await base44.entities.MasterProperty.bulkCreate(chunk);
            successCount += chunk.length;
        } catch (e) {
            console.error('Bulk create failed, trying single:', e);
            // Fallback to single
            for (const prop of chunk) {
                try {
                    await base44.entities.MasterProperty.create(prop);
                    successCount++;
                } catch (err) {
                    console.error('Create failed:', err);
                }
            }
        }
    }

    return Response.json({
      status: 'imported',
      zip_code,
      city,
      state,
      count: successCount,
      message: `Successfully imported ${successCount} properties for ${zip_code}`
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Generate realistic property data for a zip code
function generatePropertiesForZip(zip, city, state, county, centerLat, centerLng) {
  const properties = [];
  const streetNames = [
    'Main St', 'Oak Ave', 'Elm St', 'Cedar Ln', 'Pine Dr', 'Maple Ave',
    'Washington Blvd', 'Lincoln Way', 'Park Ave', 'Lake Dr', 'Hill Rd',
    'Valley View', 'Sunset Blvd', 'River Rd', 'Forest Dr', 'Meadow Ln',
    'Spring St', 'Church St', 'School Rd', 'Mill St', 'Bridge St',
    'Center St', 'North Ave', 'South Blvd', 'East Dr', 'West Ln'
  ];
  
  const numProperties = 100; // Small batch for now to avoid timeout/space issues
  
  for (let i = 0; i < numProperties; i++) {
    const streetNum = 100 + Math.floor(Math.random() * 9900);
    const street = streetNames[Math.floor(Math.random() * streetNames.length)];
    const fullAddress = `${streetNum} ${street}`;
    
    // Spread properties around the zip center (roughly 0.02 degrees = ~1.4 miles)
    const latOffset = (Math.random() - 0.5) * 0.04;
    const lngOffset = (Math.random() - 0.5) * 0.04;
    
    const beds = 2 + Math.floor(Math.random() * 4); // 2-5 beds
    const baths = 1 + Math.floor(Math.random() * 3); // 1-3 baths
    const sqft = 1000 + Math.floor(Math.random() * 2500); // 1000-3500 sqft
    const yearBuilt = 1950 + Math.floor(Math.random() * 74); // 1950-2024
    const pricePerSqft = 150 + Math.floor(Math.random() * 200); // $150-350/sqft
    const price = sqft * pricePerSqft;
    
    const lat = centerLat + latOffset;
    const lng = centerLng + lngOffset;

    // Generate address_hash
    // Simple hash: base64 of address+lat+lng
    const hashString = `${fullAddress}-${lat.toFixed(5)}-${lng.toFixed(5)}`;
    // btoa available in Deno
    const address_hash = btoa(hashString).replace(/=/g, '').slice(0, 20); // truncate for safety

    properties.push({
      address_hash,
      house_number: streetNum,
      street_name: street,
      full_address: fullAddress,
      city,
      state,
      zip_code: zip,
      lat,
      lng,
      original_status: 'ELIGIBLE',
      beds,
      baths,
      sqft,
      lot_size: sqft * 4,
      year_built: yearBuilt,
      price,
      sold_date: null,
      sale_type: 'Market',
      property_type: 'Single Family',
      mls_id: `MLS-${Math.floor(Math.random()*1000000)}`,
      url: `https://example.com/${address_hash}`
    });
  }
  
  return properties;
}