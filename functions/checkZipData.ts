import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
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
    
    // 4. If a zip code was provided, count records
    let zipCounts = {};
    if (zipCode && zipColumns.length > 0) {
      for (const col of zipColumns) {
        const countResult = await sql`
          SELECT COUNT(*) as count 
          FROM properties 
          WHERE ${sql(col)} = ${zipCode}
        `;
        zipCounts[col] = parseInt(countResult[0].count);
      }
    }
    
    // 5. Get sample of zip codes that actually have data
    let sampleZips = [];
    if (zipColumns.length > 0) {
      const zipCol = zipColumns[0];
      const samples = await sql`
        SELECT ${sql(zipCol)} as zip, COUNT(*) as count 
        FROM properties 
        WHERE ${sql(zipCol)} IS NOT NULL
        GROUP BY ${sql(zipCol)}
        ORDER BY count DESC
        LIMIT 10
      `;
      sampleZips = samples;
    }
    
    // 6. Sample record to see actual data
    const sampleRecord = await sql`SELECT * FROM properties LIMIT 1`;
    
    return Response.json({
      allColumns: columns,
      zipColumns,
      latColumns,
      lngColumns,
      zipCountsForQuery: zipCounts,
      topZipCodes: sampleZips,
      sampleRecord: sampleRecord[0]
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});