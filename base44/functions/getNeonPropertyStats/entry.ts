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

        if (body.recent_sold_check === true) {
            const toIsoDate = (value) => {
                if (!value) return null;
                const parsed = new Date(value);
                return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : String(value).slice(0, 10);
            };
            const updatedSince = body.updated_since ? String(body.updated_since) : '2026-06-30T23:00:00.000Z';
            const oneDayCutoff = body.one_day_cutoff ? String(body.one_day_cutoff) : '2026-06-29';
            const twoDayCutoff = body.two_day_cutoff ? String(body.two_day_cutoff) : '2026-06-28';
            const recentRows = await sql`
                SELECT
                    wp.fetch_job_id,
                    wp.route_active,
                    wp.status AS workspace_status,
                    p.full_address,
                    p.sold_date,
                    p.original_status,
                    p.sale_confidence,
                    p.updated_at,
                    p.created_at
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                WHERE wp.user_email = ${targetEmail}
                  AND p.updated_at >= ${updatedSince}
                ORDER BY p.sold_date DESC NULLS LAST, p.updated_at DESC
                LIMIT 500
            `;
            const rows = recentRows.map(row => ({
                fetch_job_id: row.fetch_job_id,
                address: row.full_address,
                sold_date: toIsoDate(row.sold_date),
                route_active: row.route_active,
                workspace_status: row.workspace_status,
                original_status: row.original_status,
                sale_confidence: row.sale_confidence,
                updated_at: row.updated_at
            }));
            return Response.json({
                success: true,
                user_email: targetEmail,
                updated_since: updatedSince,
                one_day_cutoff: oneDayCutoff,
                two_day_cutoff: twoDayCutoff,
                rows_checked: rows.length,
                sold_1_day_count: rows.filter(row => row.sold_date && row.sold_date >= oneDayCutoff).length,
                sold_2_day_count: rows.filter(row => row.sold_date && row.sold_date >= twoDayCutoff).length,
                distinct_sold_dates: [...new Set(rows.map(row => row.sold_date).filter(Boolean))].sort().reverse(),
                rows_sold_1_or_2_days: rows.filter(row => row.sold_date && row.sold_date >= twoDayCutoff).slice(0, 50),
                recent_rows_sample: rows.slice(0, 50)
            });
        }

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