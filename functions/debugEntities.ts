import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Check MasterProperty
        const props = await base44.entities.MasterProperty.list('-created_date', 1);
        
        // Check if we can find property by zip
        const zipProps = await base44.entities.MasterProperty.filter({ zip_code: '29412' }, '-created_date', 10);
        
        return Response.json({
            sample: props[0] || null,
            count_29412: zipProps.length,
            zip_29412_sample: zipProps[0] || null
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});