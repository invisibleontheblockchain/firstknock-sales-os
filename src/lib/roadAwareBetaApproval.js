// One comparison host serves manager and rep Optimize actions. No route write
// happens until the promise resolves with the explicit Use New Route choice.
let listener = null;
let pending = false;
export function subscribeRoadAwareApproval(callback) {
    listener = callback;
    return () => { if (listener === callback) listener = null; };
}
export function requestRoadAwareApproval(preview) {
    if (!listener) throw new Error('Route comparison is unavailable. The route was left unchanged.');
    if (pending) throw new Error('Finish the open route comparison first.');
    pending = true;
    return new Promise(resolve => listener({ ...preview, decide(value) {
        pending = false; listener?.(null); resolve(value);
    } }));
}
