/**
 * One guard for the routing context, shared by route generation, reorder and the
 * single-route reoptimize/anchor action. A context that cannot group access
 * points is not a safe basis for rewriting somebody's route.
 */
export function requireUsableRouteContext(routingContext) {
    if (
        routingContext
        && ['full', 'cost-only', 'fallback'].includes(routingContext.mode)
        && typeof routingContext.accessGroupKey === 'function'
    ) return;
    throw new Error(
        'The route optimizer could not initialize safely. No routes were changed.'
    );
}