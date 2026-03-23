import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = Deno.env.get("DATABASE_URL");
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    const { zipCode } = await req.json();
    
    // 1. Get schema - what columns exist?
    const schema = await sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'properties'
      ORDER BY ordinal_position
    `;
    const columns = schema.map(c => c.column_name);
    
    // 2. Find which zip column exists
    const zipColumns = columns.filter(c => 
      c.toLowerCase().includes('zip') || c.toLowerCase().includes('postal')
    );
    
    // 3. Check for lat/lng columns
    const latColumns = columns.filter(c => 
      c.toLowerCase().includes('lat')
    );
    const lngColumns = columns.filter(c => 
      c.toLowerCase().includes('lng') || c.toLowerCase().includes('lon')
    );
    
    // 4. If a zip code was provided, count records using raw queries
    let zipCounts = {};
    if (zipCode && zipColumns.length > 0) {
      for (const col of zipColumns) {
        // Use raw query since dynamic column names are tricky
        const countResult = await sql(`SELECT COUNT(*) as count FROM properties WHERE "${col}" = '${zipCode}'`);
        zipCounts[col] = parseInt(countResult[0].count);
      }
    }
    
    // 5. Get sample of zip codes that actually have data
    let sampleZips = [];
    if (zipColumns.length > 0) {
      const zipCol = zipColumns[0];
      const samples = await sql(`
        SELECT "${zipCol}" as zip, COUNT(*) as count 
        FROM properties 
        WHERE "${zipCol}" IS NOT NULL
        GROUP BY "${zipCol}"
        ORDER BY count DESC
        LIMIT 10
      `);
      sampleZips = samples;
    }
    
    // 6. Sample record to see actual data
    const sampleRecord = await sql`SELECT * FROM properties LIMIT 1`;
    
    // Get total record count
    const totalCount = await sql`SELECT COUNT(*) as total FROM properties`;
    
    // 7. Check how many records have lat/lng
    const coordStats = await sql`
      SELECT 
        COUNT(*) as total,
        COUNT(latitude) as with_lat,
        COUNT(longitude) as with_lng
      FROM properties
    `;
    
    // 8. If zip provided, check coords for that zip
    let zipWithCoords = null;
    if (zipCode) {
      const coordCheck = await sql`
        SELECT COUNT(*) as total,
               COUNT(latitude) as with_coords
        FROM properties 
        WHERE zip_code = ${zipCode}
      `;
      zipWithCoords = coordCheck[0];
    }
    
    return Response.json({
      totalRecords: parseInt(totalCount[0].total),
      allColumns: columns,
      zipColumns,
      latColumns,
      lngColumns,
      zipCountsForQuery: zipCounts,
      topZipCodes: sampleZips,
      sampleRecord: sampleRecord[0],
      coordinateStats: coordStats[0],
      zipCoordinateStats: zipWithCoords
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});