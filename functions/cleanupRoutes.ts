import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const sql = neon(Deno.env.get("DATABASE_URL"));

Deno.serve(async (req) => {
    try {
        const schema = await sql`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public'
        `;
        
        return Response.json({
            tables: schema.map(t => t.table_name)
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});