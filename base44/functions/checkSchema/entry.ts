import { neon } from 'npm:@neondatabase/serverless@0.6.0';

export default async function handler(req) {
    try {
        const databaseUrl = Deno.env.get('DATABASE_URL') || Deno.env.get('NEON_DATABASE_URL');
        if (!databaseUrl) {
            return new Response(JSON.stringify({
                error: 'Database connection is not configured on the server.'
            }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const sql = neon(databaseUrl);
        
        const columns = await sql`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'properties'
        `;
        
        return new Response(JSON.stringify({ columns }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
