export const PRECISION_PIPELINE_CONTRACT = 'precision_generate_v2';

export const REQUIRED_PRECISION_COMPONENTS = [
    'startBatchDataPull',
    'processFetchChunk',
    'fetchJobStatus',
    'getRouteCandidatesFromNeon',
    'previewBatchDataArea'
];

export function summarizePrecisionPipelineComponents(results = []) {
    const byComponent = new Map((Array.isArray(results) ? results : []).map(result => [result?.component, result]));
    const components = REQUIRED_PRECISION_COMPONENTS.map(component => {
        const result = byComponent.get(component) || {};
        return {
            component,
            ready: result.precision_pipeline_contract === PRECISION_PIPELINE_CONTRACT,
            precision_pipeline_contract: result.precision_pipeline_contract || null,
            error: result.error || null
        };
    });
    return {
        ready: components.every(component => component.ready),
        precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
        components
    };
}
