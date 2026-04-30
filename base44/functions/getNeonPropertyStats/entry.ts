import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
        }

        const sql = neon(databaseUrl);
        const body = await req.json().catch(() => ({}));
        const targetEmail = user.role === 'admin' && body.user_email ? body.user_email : user.email;

        const totals = await sql`
            SELECT
                COUNT(*)::int AS total_properties,
                COUNT(*) FILTER (WHERE wp.route_active = TRUE)::int AS active_properties,
                COUNT(DISTINCT p.zip_code)::int AS zip_count
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
        `;

        const topZips = await sql`
            SELECT p.zip_code, COUNT(*)::int AS count
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail} AND p.zip_code IS NOT NULL
            GROUP BY p.zip_code
            ORDER BY count DESC
            LIMIT 20
        `;

        return Response.json({
            success: true,
            user_email: targetEmail,
            ...totals[0],
            top_zips: topZips
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});