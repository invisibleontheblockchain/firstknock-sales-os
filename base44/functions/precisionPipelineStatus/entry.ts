import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
    PRECISION_PIPELINE_CONTRACT,
    summarizePrecisionPipelineComponents
} from './contractLogic.js';

const PROBES = [
    { component: 'startBatchDataPull', payload: { contract_probe: true } },
    { component: 'processFetchChunk', payload: { contract_probe: true, self_test: true } },
    { component: 'fetchJobStatus', payload: { contract_probe: true } },
    { component: 'getRouteCandidatesFromNeon', payload: { contract_probe: true, limit: 1 } },
    { component: 'previewBatchDataArea', payload: { contract_probe: true } }
];

function unwrapFunctionResponse(value) {
    return value?.data && typeof value.data === 'object' ? value.data : (value || {});
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const results = await Promise.all(PROBES.map(async ({ component, payload }) => {
            try {
                const response = await base44.asServiceRole.functions.invoke(component, payload);
                const data = unwrapFunctionResponse(response);
                return {
                    component,
                    precision_pipeline_contract: data.precision_pipeline_contract || null,
                    error: data.error || null
                };
            } catch (error) {
                return {
                    component,
                    precision_pipeline_contract: null,
                    error: error?.message || 'component probe failed'
                };
            }
        }));
        const summary = summarizePrecisionPipelineComponents(results);
        return Response.json({
            success: summary.ready,
            ...summary,
            paid_provider_requests: 0,
            message: summary.ready
                ? 'Precision Generate frontend and backend contracts match.'
                : 'Precision Generate is temporarily blocked because one or more backend components are on a different release.'
        });
    } catch (error) {
        return Response.json({
            success: false,
            ready: false,
            precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
            paid_provider_requests: 0,
            error: error?.message || 'Precision pipeline status failed'
        }, { status: 500 });
    }
});
