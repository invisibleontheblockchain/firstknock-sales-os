/**
 * Run Route scope toggles.
 *
 * Two switches narrow which stops a route shows before any decision filter runs:
 * "Remove LLC" drops business-owned doors, and "New build" keeps only homes
 * finished inside the rolling new-construction window (this calendar year or
 * last one — see isNewConstruction). Both are derived display rules, so they
 * apply to every route already in the system; nothing is stored per property.
 *
 * The filter is pure and lives here rather than in the checklist component so
 * it can be executed in tests.
 */

import { isBusinessOwnedProperty } from '../components/logic/ownerType.js';
import { isNewConstruction } from './newConstruction.js';

/**
 * How many stops each toggle would act on. Counts come from the full route, not
 * the already-filtered list, so a badge never changes as toggles are flipped.
 */
export function countRouteScope(properties, now = new Date()) {
    const list = Array.isArray(properties) ? properties : [];
    let businessOwned = 0;
    let newBuild = 0;
    list.forEach((property) => {
        if (isBusinessOwnedProperty(property)) businessOwned += 1;
        if (isNewConstruction(property, now)) newBuild += 1;
    });
    return { businessOwned, newBuild };
}

/**
 * The toggles stack: with both on, a stop must be non-business AND a new build.
 * With neither on the original array is returned so callers keep a stable
 * reference for memoization.
 */
export function applyRouteScopeFilters(properties, options = {}, now = new Date()) {
    const list = Array.isArray(properties) ? properties : [];
    const { hideBusinessOwned = false, newBuildsOnly = false } = options;
    if (!hideBusinessOwned && !newBuildsOnly) return list;
    return list.filter((property) => {
        if (hideBusinessOwned && isBusinessOwnedProperty(property)) return false;
        if (newBuildsOnly && !isNewConstruction(property, now)) return false;
        return true;
    });
}
