import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(connectionString);

Deno.serve(async (req) => {
  try {
    // Find all zip codes in Charleston County SC with their counts
    const charlestonZips = await sql`
      SELECT zip_code, city, county, COUNT(*) as count
      FROM properties
      WHERE county = 'Charleston' AND state = 'SC'
      GROUP BY zip_code, city, county
      ORDER BY count DESC
    `;
    
    // Also find any 294xx zip codes (Charleston area)
    const zip294 = await sql`
      SELECT zip_code, city, state, county, COUNT(*) as count
      FROM properties
      WHERE zip_code LIKE '294%'
      GROUP BY zip_code, city, state, county
      ORDER BY count DESC
      LIMIT 30
    `;
    
    return Response.json({
      charlestonCountyZips: charlestonZips,
      all294Zips: zip294
    });
    
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});