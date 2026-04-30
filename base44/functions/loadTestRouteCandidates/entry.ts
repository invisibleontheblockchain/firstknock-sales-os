import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const iterations = Math.min(Math.max(Number(body.iterations || 5), 1), 25);
        const limit = Math.min(Math.max(Number(body.limit || 1000), 1), 10000);
        const targetEmail = body.user_email || user.email;
        const sql = neon(databaseUrl);
        const runs = [];

        for (let i = 0; i < iterations; i++) {
            const started = Date.now();
            const rows = await sql`
                SELECT p.id, p.address_hash, p.lat, p.lng, p.zip_code, p.sold_date
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                WHERE wp.user_email = ${targetEmail}
                  AND wp.route_active = TRUE
                  AND p.lat IS NOT NULL
                  AND p.lng IS NOT NULL
                  AND COALESCE(p.original_status, '') <> 'REJECTED'
                  AND COALESCE(p.sale_confidence, '') <> 'REJECTED'
                ORDER BY p.sold_date DESC NULLS LAST, p.updated_at DESC
                LIMIT ${limit}
            `;
            runs.push({ iteration: i + 1, count: rows.length, latency_ms: Date.now() - started });
        }

        const latencies = runs.map(r => r.latency_ms).sort((a, b) => a - b);
        const avg = Math.round(latencies.reduce((sum, n) => sum + n, 0) / latencies.length);
        const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];

        return Response.json({
            success: true,
            user_email: targetEmail,
            iterations,
            limit,
            avg_latency_ms: avg,
            p95_latency_ms: p95,
            runs
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});