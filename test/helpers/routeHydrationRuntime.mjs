import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as hydration from '../../src/components/logic/routeHydrationCore.js';
import { withReadDeadline } from '../../src/lib/readRequest.js';
import { mapWithConcurrency } from '../../src/lib/mapWithConcurrency.js';

export function createRouteHydrationRuntime(client) {
    const source = readFileSync(new URL('../../src/components/logic/routeHydration.jsx', import.meta.url), 'utf8');
    const sandbox = { ...hydration, withReadDeadline, mapWithConcurrency, base44: client };
    vm.runInNewContext(source.replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '')
        + '\nglobalThis.api = { hydrateRouteForMap, hydrateRoutesForMap };', sandbox);
    return sandbox.api;
}
