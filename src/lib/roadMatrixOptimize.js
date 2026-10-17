// The multi-pass road search lives in base44/shared/roadMatrixSearch.js so the
// server's background worker runs exactly the same search as the app. Here the
// app supplies its signed-in client.

import { base44 } from '@/api/base44Client';
import { tryRoadMatrixOptimize as searchRoads } from '../../base44/shared/roadMatrixSearch.js';

export { buildRoadMatrixRoutingBlock, normalizeRoadSearchCoverage } from '../../base44/shared/roadMatrixSearch.js';

export function tryRoadMatrixOptimize(routeProperties, options = {}) {
    return searchRoads(routeProperties, { ...options, client: options.client || base44 });
}
