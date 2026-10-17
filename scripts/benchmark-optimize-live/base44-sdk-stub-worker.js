// Benchmark-only stand-in for the Base44 SDK as the background worker meets it:
// no signed-in user, so optimizeRouteRoadMatrix must accept the worker credential.
export const createClientFromRequest = () => ({ auth: { me: async () => null } });
