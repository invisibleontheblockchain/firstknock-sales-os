import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import { createHash } from 'node:crypto';

// Connection string for Neon DB (Dark Room)
const CONNECTION_STRING = Deno.env.get("DATABASE_URL");

// Helper to generate deterministic ID
function generatePropertyId(address, zip, city) {
    const raw = `${address?.trim().toUpperCase()}|${city?.trim().toUpperCase()}|${zip?.trim()}`;
    return createHash('sha256').update(raw).digest('hex');
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const secretHeader = req.headers.get('x-pipeline-secret');
        const envSecret = Deno.env.get('PIPELINE_SECRET');
        const isSecretValid = envSecret && secretHeader === envSecret;

        // Auth Check (Secret or Admin)
        if (!isSecretValid) {
            const user = await base44.auth.me();
            if (!user || user.role !== 'admin') {
                return Response.json({ error: 'Unauthorized' }, { status: 403 });
            }
        }

        // HEALTH CHECK (GET)
        if (req.method === 'GET') {
            try {
                const sql = neon(CONNECTION_STRING);
                // Simple check + table existence check
                const [result] = await sql`
                    SELECT 
                        count(*) as count,
                        EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'properties') as table_exists
                    FROM properties`;
                
                return Response.json({ 
                    status: 'online', 
                    message: 'Connected to Neon',
                    details: result
                });
            } catch (e) {
                // If table doesn't exist, it might throw, so we catch specifically
                if (e.message.includes('relation "properties" does not exist')) {
                     return Response.json({ 
                        status: 'connected_no_table', 
                        message: 'Connected, but "properties" table missing. Run SQL Schema.' 
                    });
                }
                return Response.json({ status: 'error', message: e.message }, { status: 500 });
            }
        }

        // INGESTION (POST)
        if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

        // 2. Parse Payload
        const payload = await req.json();
        const { properties, source } = payload; // properties: Array<Object>, source: string (e.g. "COUNTY_DATA_V1")

        if (!Array.isArray(properties) || properties.length === 0) {
            return Response.json({ error: 'Payload must contain a "properties" array' }, { status: 400 });
        }

        console.log(`[Ingest] Received ${properties.length} properties from source: ${source || 'Unknown'}`);

        // 3. Connect to Neon
        const sql = neon(CONNECTION_STRING);

        // 4. Batch Insert
        // We use Promise.all for parallelism. Neon Serverless handles this well via HTTP pipeline.
        // For massive loads, client should chunk to ~100-500 items per request.
        
        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        // Chunking locally to prevent overwhelming the lambda if payload is huge
        const CHUNK_SIZE = 50; 
        
        for (let i = 0; i < properties.length; i += CHUNK_SIZE) {
            const chunk = properties.slice(i, i + CHUNK_SIZE);
            
            await Promise.all(chunk.map(async (p) => {
                try {
                    // Validations / Defaults
                    const lat = parseFloat(p.lat || p.Latitude);
                    const lng = parseFloat(p.lng || p.Longitude);
                    if (isNaN(lat) || isNaN(lng)) throw new Error('Invalid coordinates');

                    // Map fields to Schema
                    // Generate deterministic ID for deduplication
                    const propertyId = generatePropertyId(
                        p.address || p.PropertyAddress, 
                        p.zip_code || p.Zip,
                        p.city || p.City
                    );

                    await sql`
                        INSERT INTO properties (
                            id,
                            address, 
                            city, 
                            state, 
                            zip_code, 
                            location, 
                            smart_score, 
                            beds, 
                            baths, 
                            sqft, 
                            year_built, 
                            price, 
                            sold_date,
                            owner_name,
                            property_type,
                            mls_id
                        ) VALUES (
                            ${propertyId},
                            ${p.address || p.PropertyAddress}, 
                            ${p.city || p.City}, 
                            ${p.state || p.State}, 
                            ${p.zip_code || p.Zip},
                            ST_SetSRID(ST_Point(${lng}, ${lat}), 4326),
                            ${p.smart_score || 0}, 
                            ${p.beds || p.Bedrooms || 0}, 
                            ${p.baths || p.Bathrooms || 0}, 
                            ${p.sqft || p.TotalLivingArea || 0}, 
                            ${p.year_built || p.YearBuilt || null}, 
                            ${p.price || p.SalePrice || 0}, 
                            ${p.sold_date || p.SaleDate || null},
                            ${p.owner_name || null},
                            ${p.property_type || null},
                            ${p.mls_id || null}
                        )
                        ON CONFLICT (id) DO UPDATE SET
                            smart_score = EXCLUDED.smart_score,
                            price = EXCLUDED.price,
                            sold_date = EXCLUDED.sold_date,
                            owner_name = EXCLUDED.owner_name,
                            location = EXCLUDED.location
                    `;
                    successCount++;
                } catch (err) {
                    errorCount++;
                    // Only log first few errors to keep logs clean
                    if (errors.length < 5) errors.push({ address: p.address, error: err.message });
                }
            }));
        }

        return Response.json({
            success: true,
            summary: {
                total: properties.length,
                inserted: successCount,
                failed: errorCount,
                errors: errors // Sample errors
            }
        });

    } catch (error) {
        console.error('[Ingest] Critical Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});