import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const propertiesRaw = await base44.asServiceRole.entities.MasterProperty.list('-created_date', 10000);
        const properties = Array.isArray(propertiesRaw) ? propertiesRaw : (propertiesRaw?.items || []);
        const sample = properties.find(p => String(p.sale_type || '').toLowerCase() === 'mls');

        return Response.json({
            found: !!sample,
            sale_type: sample?.sale_type ?? null,
            mls_id: sample?.mls_id ?? null,
            original_status: sample?.original_status ?? null,
            sold_date: sample?.sold_date ?? null,
            data_source: sample?.data_source ?? null,
            id: sample?.id ?? null,
            scanned: properties.length
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});