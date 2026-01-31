import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const connectionString = Deno.env.get("DATABASE_URL");
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    const { zip_code, force_sync } = await req.json();
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!zip_code || zip_code.length !== 5) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    // Check existing count
    const existing = await base44.entities.MasterProperty.filter({ zip_code }, '-created_date', 5000);
    
    if (existing.length > 0 && !force_sync) {
      return Response.json({ 
        status: 'exists',
        count: existing.length,
        message: `Already have properties for ${zip_code}`
      });
    }

    // Query Neon for real properties in this zip
    console.log(`Querying Neon for zip: ${zip_code}`);
    
    // Using latitude/longitude columns if available, otherwise would need ST_X/ST_Y from location
    // We assume latitude/longitude exist based on checkZipData output
    const neonProperties = await sql`
        SELECT 
            id, address, city, state, zip_code, 
            latitude, longitude, 
            beds, baths, sqft, year_built, price, 
            status, property_type
        FROM properties 
        WHERE zip_code = ${zip_code}
        LIMIT 2500
    `;

    console.log(`Found ${neonProperties.length} records in Neon`);

    if (neonProperties.length === 0) {
        return Response.json({
            status: 'empty',
            count: 0,
            message: `No properties found in Neon for zip ${zip_code}. Please ingest data first.`
        });
    }

    // Differential Sync: Filter out properties we already have
    const existingHashes = new Set(existing.map(p => p.address_hash));
    const newRecords = neonProperties.filter(p => !existingHashes.has(p.id));
    
    console.log(`Syncing: ${newRecords.length} new records (skipped ${neonProperties.length - newRecords.length} duplicates)`);

    if (newRecords.length === 0) {
         return Response.json({
            status: 'synced',
            count: 0,
            message: `All ${neonProperties.length} properties are already in the app.`
        });
    }

    // Map to MasterProperty schema
    const properties = newRecords.map(p => {
        // Parse address for house number / street name
        // Simple regex to split first number from rest
        const addressMatch = (p.address || "").match(/^(\d+)\s+(.*)$/);
        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
        const street_name = addressMatch ? addressMatch[2] : (p.address || "Unknown");

        // Map Status
        let original_status = 'ELIGIBLE';
        if (p.status && p.status.toLowerCase().includes('sold')) original_status = 'SOLD';
        
        return {
            address_hash: p.id, // Use Neon ID as hash
            house_number,
            street_name,
            full_address: p.address,
            city: p.city,
            state: p.state,
            zip_code: p.zip_code,
            lat: parseFloat(p.latitude),
            lng: parseFloat(p.longitude),
            original_status,
            beds: parseInt(p.beds) || 0,
            baths: parseFloat(p.baths) || 0,
            sqft: parseInt(p.sqft) || 0,
            lot_size: 0,
            year_built: parseInt(p.year_built) || 0,
            price: parseFloat(p.price) || 0,
            sold_date: null,
            sale_type: 'Market',
            property_type: p.property_type || 'Single Family',
            mls_id: null,
            url: null,
            created_by: user ? user.email : undefined // EXPLICITLY set owner to current user
        };
    });
    
    // Insert into MasterProperty using SDK
    let successCount = 0;
    
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
      count: successCount,
      message: `Successfully imported ${successCount} properties from Neon for ${zip_code}`
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});